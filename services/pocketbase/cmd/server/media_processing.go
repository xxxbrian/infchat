package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path"
	"strconv"
	"strings"
	"time"

	blurhash "github.com/bbrks/go-blurhash"
	"github.com/disintegration/imaging"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
)

const (
	mediaProcessingCommandTimeout  = 90 * time.Second
	mediaProcessingLeaseDuration   = 5 * time.Minute
	mediaProcessingPollInterval    = 2 * time.Second
	mediaProcessingMaxAttempts     = 6
	mediaProcessingThumbnailMaxDim = 320
	mediaProcessingPreviewMaxDim   = 1280
	mediaProcessingPosterMaxDim    = 640
	mediaProcessingJPEGQuality     = 84
)

type processedMediaVariant struct {
	ByteSize   int64
	DurationMs int
	ETag       string
	Height     int
	MimeType   string
	ObjectKey  string
	Sha256     string
	Variant    string
	Width      int
}

type processedAttachmentMetadata struct {
	Blurhash   string
	ByteSize   int64
	DurationMs int
	Height     int
	MimeType   string
	Sha256     string
	Variants   []processedMediaVariant
	Width      int
}

type downloadedMediaObject struct {
	ByteSize    int64
	ContentType string
	Path        string
	Sha256      string
}

type ffprobeOutput struct {
	Format struct {
		Duration string `json:"duration"`
		Size     string `json:"size"`
	} `json:"format"`
	Streams []struct {
		CodecType    string            `json:"codec_type"`
		Duration     string            `json:"duration"`
		Height       int               `json:"height"`
		SideDataList []ffprobeSideData `json:"side_data_list"`
		Tags         map[string]string `json:"tags"`
		Width        int               `json:"width"`
	} `json:"streams"`
}

type ffprobeSideData struct {
	Rotation int `json:"rotation"`
}

type probedVisualMedia struct {
	DurationMs int
	Height     int
	Width      int
}

func bindMediaProcessingWorker(app *pocketbase.PocketBase) {
	if !envBool("INFCHAT_MEDIA_PROCESSING_ENABLED", true) {
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	workerCount := int(envInt64("INFCHAT_MEDIA_PROCESSING_WORKERS", 1))
	if workerCount < 1 {
		workerCount = 1
	}
	if workerCount > 4 {
		workerCount = 4
	}

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		for index := 0; index < workerCount; index++ {
			workerID := fmt.Sprintf("%s-%d", mediaProcessingWorkerOwner(), index+1)
			go runMediaProcessingWorker(ctx, se.App, workerID)
		}

		return se.Next()
	})
	app.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
		cancel()

		return e.Next()
	})
}

func mediaProcessingWorkerOwner() string {
	hostname, err := os.Hostname()
	if err != nil || strings.TrimSpace(hostname) == "" {
		hostname = "unknown-host"
	}

	return sanitizeObjectKeySegment(hostname) + "-" + strconv.Itoa(os.Getpid())
}

func runMediaProcessingWorker(ctx context.Context, app core.App, owner string) {
	ticker := time.NewTicker(mediaProcessingPollInterval)
	defer ticker.Stop()

	for {
		job, err := leaseNextMediaProcessingJob(app, owner)
		if err != nil {
			if !errors.Is(err, sql.ErrNoRows) {
				app.Logger().Warn("Failed to lease media processing job", "error", err)
			}
		} else if job != nil {
			if err := processMediaProcessingJob(ctx, app, job); err != nil {
				app.Logger().Warn("Media processing job failed", "jobId", job.Id, "error", err)
				if markErr := markMediaProcessingJobFailed(app, job, err); markErr != nil {
					app.Logger().Warn("Failed to mark media processing job failure", "jobId", job.Id, "error", markErr)
				}
			} else if err := markMediaProcessingJobSucceeded(app, job); err != nil {
				app.Logger().Warn("Failed to mark media processing job success", "jobId", job.Id, "error", err)
			}
			continue
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func enqueueMediaProcessingJobsForAttachments(app core.App, attachments []*core.Record) error {
	if len(attachments) == 0 {
		return nil
	}
	collection, err := app.FindCollectionByNameOrId("media_processing_jobs")
	if err != nil {
		return err
	}

	for _, attachment := range attachments {
		kind := attachment.GetString("kind")
		if !mediaAttachmentRequiresProcessing(kind) {
			continue
		}
		if _, err := app.FindFirstRecordByFilter("media_processing_jobs", "attachment={:attachment}", dbx.Params{"attachment": attachment.Id}); err == nil {
			continue
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		job := core.NewRecord(collection)
		job.Set("attachment", attachment.Id)
		job.Set("kind", kind)
		job.Set("state", "queued")
		job.Set("attempt_count", 0)
		job.Set("next_attempt_at", types.NowDateTime())
		if err := app.Save(job); err != nil {
			return err
		}
	}

	return nil
}

func leaseNextMediaProcessingJob(app core.App, owner string) (*core.Record, error) {
	now := types.NowDateTime()
	leaseUntil := now.Add(mediaProcessingLeaseDuration)
	var jobID string
	err := app.DB().NewQuery(
		`UPDATE media_processing_jobs
		 SET state='processing',
		     attempt_count=COALESCE(attempt_count, 0) + 1,
		     lease_owner={:owner},
		     leased_until={:leaseUntil},
		     last_error='',
		     updated={:now}
		 WHERE id = (
		   SELECT id FROM media_processing_jobs
		   WHERE (state='queued' OR state='failed' OR (state='processing' AND leased_until != '' AND leased_until <= {:now}))
		     AND (next_attempt_at='' OR next_attempt_at <= {:now})
		   ORDER BY updated ASC, id ASC
		   LIMIT 1
		 )
		 RETURNING id`,
	).Bind(dbx.Params{
		"leaseUntil": leaseUntil.String(),
		"now":        now.String(),
		"owner":      owner,
	}).Row(&jobID)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(jobID) == "" {
		return nil, sql.ErrNoRows
	}

	return app.FindRecordById("media_processing_jobs", jobID)
}

func processMediaProcessingJob(ctx context.Context, app core.App, job *core.Record) error {
	attachment, err := app.FindRecordById("message_attachments", job.GetString("attachment"))
	if err != nil {
		return err
	}
	if !mediaAttachmentRequiresProcessing(attachment.GetString("kind")) {
		return nil
	}
	attachment.Set("processing_status", "processing")
	attachment.Set("processing_error", "")
	if err := app.Save(attachment); err != nil {
		return err
	}

	original, err := findOriginalAttachmentVariant(app, attachment.Id)
	if err != nil {
		return err
	}
	storage, err := newMediaObjectStorageFromEnv(ctx)
	if err != nil {
		return mediaStorageAPIError(err)
	}
	profileRecord, err := ensureStorageProfileRecord(app, storage.Profile())
	if err != nil {
		return err
	}

	var metadata processedAttachmentMetadata
	switch attachment.GetString("kind") {
	case "image":
		metadata, err = processImageAttachment(ctx, storage, attachment, original)
	case "video":
		metadata, err = processVideoAttachment(ctx, storage, attachment, original)
	default:
		return nil
	}
	if err != nil {
		return err
	}

	return persistProcessedAttachment(app, attachment.Id, original.Id, profileRecord.Id, metadata)
}

func findOriginalAttachmentVariant(app core.App, attachmentID string) (*core.Record, error) {
	variant, err := app.FindFirstRecordByFilter(
		"attachment_variants",
		"attachment={:attachment} && variant='original'",
		dbx.Params{"attachment": attachmentID},
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("original attachment variant was not found")
		}
		return nil, err
	}

	return variant, nil
}

func processImageAttachment(ctx context.Context, storage mediaObjectStorage, attachment *core.Record, original *core.Record) (processedAttachmentMetadata, error) {
	down, err := downloadMediaObjectToTemp(ctx, storage, original.GetString("object_key"), "infchat-image-*")
	if err != nil {
		return processedAttachmentMetadata{}, err
	}
	defer os.Remove(down.Path)

	img, err := decodeImageFile(down.Path)
	if err != nil {
		return processImageAttachmentWithFFmpeg(ctx, storage, attachment, original, down)
	}

	width, height := imageDimensions(img)
	metadata := processedAttachmentMetadata{
		ByteSize: down.ByteSize,
		Height:   height,
		MimeType: effectiveOriginalMimeType(attachment, original, down.ContentType),
		Sha256:   down.Sha256,
		Width:    width,
	}
	if err := verifyOriginalSha256(attachment, down.Sha256); err != nil {
		return processedAttachmentMetadata{}, err
	}
	if hash, err := imageBlurhash(img); err == nil {
		metadata.Blurhash = hash
	}

	thumbnail, err := uploadImageDerivative(ctx, storage, original, img, "thumbnail", mediaProcessingThumbnailMaxDim)
	if err != nil {
		return processedAttachmentMetadata{}, err
	}
	preview, err := uploadImageDerivative(ctx, storage, original, img, "preview", mediaProcessingPreviewMaxDim)
	if err != nil {
		return processedAttachmentMetadata{}, err
	}
	metadata.Variants = []processedMediaVariant{thumbnail, preview}

	return metadata, nil
}

func processImageAttachmentWithFFmpeg(ctx context.Context, storage mediaObjectStorage, attachment *core.Record, original *core.Record, down downloadedMediaObject) (processedAttachmentMetadata, error) {
	if err := verifyOriginalSha256(attachment, down.Sha256); err != nil {
		return processedAttachmentMetadata{}, err
	}
	probed, err := probeVisualMediaFile(ctx, down.Path)
	if err != nil {
		return processedAttachmentMetadata{}, err
	}

	metadata := processedAttachmentMetadata{
		ByteSize: down.ByteSize,
		Height:   probed.Height,
		MimeType: effectiveOriginalMimeType(attachment, original, down.ContentType),
		Sha256:   down.Sha256,
		Width:    probed.Width,
	}
	thumbnail, _, err := renderAndUploadFrameVariant(ctx, storage, original, down.Path, "thumbnail", mediaProcessingThumbnailMaxDim, 0)
	if err != nil {
		return processedAttachmentMetadata{}, err
	}
	preview, previewImage, err := renderAndUploadFrameVariant(ctx, storage, original, down.Path, "preview", mediaProcessingPreviewMaxDim, 0)
	if err != nil {
		return processedAttachmentMetadata{}, err
	}
	if previewImage != nil {
		if hash, err := imageBlurhash(previewImage); err == nil {
			metadata.Blurhash = hash
		}
	}
	metadata.Variants = []processedMediaVariant{thumbnail, preview}

	return metadata, nil
}

func processVideoAttachment(ctx context.Context, storage mediaObjectStorage, attachment *core.Record, original *core.Record) (processedAttachmentMetadata, error) {
	down, err := downloadMediaObjectToTemp(ctx, storage, original.GetString("object_key"), "infchat-video-*")
	if err != nil {
		return processedAttachmentMetadata{}, err
	}
	defer os.Remove(down.Path)
	if err := verifyOriginalSha256(attachment, down.Sha256); err != nil {
		return processedAttachmentMetadata{}, err
	}

	probed, err := probeVisualMediaFile(ctx, down.Path)
	if err != nil {
		return processedAttachmentMetadata{}, err
	}
	metadata := processedAttachmentMetadata{
		ByteSize:   down.ByteSize,
		DurationMs: probed.DurationMs,
		Height:     probed.Height,
		MimeType:   effectiveOriginalMimeType(attachment, original, down.ContentType),
		Sha256:     down.Sha256,
		Width:      probed.Width,
	}
	seekMs := 100
	if probed.DurationMs > 3000 {
		seekMs = 1000
	}
	poster, posterImage, err := renderAndUploadFrameVariant(ctx, storage, original, down.Path, "poster", mediaProcessingPosterMaxDim, seekMs)
	if err != nil {
		return processedAttachmentMetadata{}, err
	}
	thumbnail, _, err := renderAndUploadFrameVariant(ctx, storage, original, down.Path, "thumbnail", mediaProcessingThumbnailMaxDim, seekMs)
	if err != nil {
		return processedAttachmentMetadata{}, err
	}
	if posterImage != nil {
		if hash, err := imageBlurhash(posterImage); err == nil {
			metadata.Blurhash = hash
		}
	}
	metadata.Variants = []processedMediaVariant{poster, thumbnail}

	return metadata, nil
}

func persistProcessedAttachment(app core.App, attachmentID string, originalVariantID string, storageProfileID string, metadata processedAttachmentMetadata) error {
	return app.RunInTransaction(func(txApp core.App) error {
		attachment, err := txApp.FindRecordById("message_attachments", attachmentID)
		if err != nil {
			return err
		}
		message, err := txApp.FindRecordById("messages", attachment.GetString("message"))
		if err != nil {
			return err
		}
		original, err := txApp.FindRecordById("attachment_variants", originalVariantID)
		if err != nil {
			return err
		}

		setProcessedAttachmentFields(attachment, metadata)
		attachment.Set("processing_status", "ready")
		attachment.Set("processing_error", "")
		if err := txApp.Save(attachment); err != nil {
			return err
		}
		setOriginalVariantFields(original, metadata, storageProfileID)
		if err := txApp.Save(original); err != nil {
			return err
		}
		for _, variant := range metadata.Variants {
			if err := upsertProcessedAttachmentVariant(txApp, attachment, message, storageProfileID, variant); err != nil {
				return err
			}
		}

		return createMediaProcessedEvent(txApp, message)
	})
}

func setProcessedAttachmentFields(attachment *core.Record, metadata processedAttachmentMetadata) {
	if metadata.MimeType != "" {
		attachment.Set("mime_type", metadata.MimeType)
	}
	if metadata.ByteSize > 0 {
		attachment.Set("byte_size", metadata.ByteSize)
	}
	if metadata.Width > 0 {
		attachment.Set("width", metadata.Width)
	}
	if metadata.Height > 0 {
		attachment.Set("height", metadata.Height)
	}
	if metadata.DurationMs > 0 {
		attachment.Set("duration_ms", metadata.DurationMs)
	}
	if metadata.Sha256 != "" {
		attachment.Set("sha256", metadata.Sha256)
	}
	if metadata.Blurhash != "" {
		attachment.Set("blurhash", metadata.Blurhash)
	}
}

func setOriginalVariantFields(original *core.Record, metadata processedAttachmentMetadata, storageProfileID string) {
	if storageProfileID != "" {
		original.Set("storage_profile", storageProfileID)
	}
	if metadata.MimeType != "" {
		original.Set("mime_type", metadata.MimeType)
	}
	if metadata.ByteSize > 0 {
		original.Set("byte_size", metadata.ByteSize)
	}
	if metadata.Width > 0 {
		original.Set("width", metadata.Width)
	}
	if metadata.Height > 0 {
		original.Set("height", metadata.Height)
	}
	if metadata.DurationMs > 0 {
		original.Set("duration_ms", metadata.DurationMs)
	}
	if metadata.Sha256 != "" {
		original.Set("sha256", metadata.Sha256)
	}
}

func upsertProcessedAttachmentVariant(app core.App, attachment *core.Record, message *core.Record, storageProfileID string, variant processedMediaVariant) error {
	record, err := app.FindFirstRecordByFilter(
		"attachment_variants",
		"attachment={:attachment} && variant={:variant}",
		dbx.Params{"attachment": attachment.Id, "variant": variant.Variant},
	)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		collection, err := app.FindCollectionByNameOrId("attachment_variants")
		if err != nil {
			return err
		}
		record = core.NewRecord(collection)
		record.Set("attachment", attachment.Id)
	}

	record.Set("message", message.Id)
	record.Set("conversation", message.GetString("conversation"))
	record.Set("storage_profile", storageProfileID)
	record.Set("variant", variant.Variant)
	record.Set("object_key", variant.ObjectKey)
	record.Set("mime_type", variant.MimeType)
	record.Set("byte_size", variant.ByteSize)
	record.Set("width", variant.Width)
	record.Set("height", variant.Height)
	record.Set("duration_ms", variant.DurationMs)
	record.Set("sha256", variant.Sha256)
	record.Set("etag", strings.Trim(variant.ETag, "\""))

	return app.Save(record)
}

func createMediaProcessedEvent(app core.App, message *core.Record) error {
	if message.GetString("deleted_at") != "" {
		return nil
	}
	conversation, err := app.FindRecordById("conversations", message.GetString("conversation"))
	if err != nil {
		return err
	}
	cursor, err := nextConversationEventCursor(app)
	if err != nil {
		return err
	}
	conversation.Set("latest_event_cursor", cursor)
	if err := app.Save(conversation); err != nil {
		return err
	}
	attachments, variants, err := mediaRecordsForMessage(app, message.Id)
	if err != nil {
		return err
	}

	return createConversationEvent(app, conversation, "message.media_processed", message.GetString("sender"), message.GetString("sender_membership"), "", "", message.Id, cursor, conversationEventPayload{AttachmentVariants: variants, Attachments: attachments, Conversation: conversation, Message: message})
}

func markMediaProcessingJobSucceeded(app core.App, job *core.Record) error {
	job.Set("state", "succeeded")
	job.Set("leased_until", "")
	job.Set("lease_owner", "")
	job.Set("last_error", "")

	return app.Save(job)
}

func markMediaProcessingJobFailed(app core.App, job *core.Record, processingErr error) error {
	attemptCount := job.GetInt("attempt_count")
	state := "failed"
	if attemptCount >= mediaProcessingMaxAttempts {
		state = "dead"
	}
	job.Set("state", state)
	job.Set("leased_until", "")
	job.Set("lease_owner", "")
	job.Set("last_error", truncateString(processingErr.Error(), 2000))
	if state == "failed" {
		job.Set("next_attempt_at", types.NowDateTime().Add(mediaProcessingRetryDelay(attemptCount)))
	} else if err := persistFailedMediaProcessingAttachment(app, job.GetString("attachment"), processingErr); err != nil {
		return err
	}

	return app.Save(job)
}

func persistFailedMediaProcessingAttachment(app core.App, attachmentID string, processingErr error) error {
	return app.RunInTransaction(func(txApp core.App) error {
		attachment, err := txApp.FindRecordById("message_attachments", attachmentID)
		if err != nil {
			return err
		}
		message, err := txApp.FindRecordById("messages", attachment.GetString("message"))
		if err != nil {
			return err
		}
		attachment.Set("processing_status", "failed")
		attachment.Set("processing_error", truncateString(processingErr.Error(), 1000))
		if err := txApp.Save(attachment); err != nil {
			return err
		}

		return createMediaProcessedEvent(txApp, message)
	})
}

func mediaProcessingRetryDelay(attemptCount int) time.Duration {
	if attemptCount < 1 {
		attemptCount = 1
	}
	exponent := attemptCount - 1
	if exponent > 5 {
		exponent = 5
	}
	delay := time.Duration(1<<exponent) * time.Minute
	if delay > 30*time.Minute {
		return 30 * time.Minute
	}

	return delay
}

func downloadMediaObjectToTemp(ctx context.Context, storage mediaObjectStorage, objectKey string, pattern string) (downloadedMediaObject, error) {
	body, info, err := storage.GetObject(ctx, objectKey)
	if err != nil {
		return downloadedMediaObject{}, err
	}
	defer body.Close()

	tmp, err := os.CreateTemp("", pattern)
	if err != nil {
		return downloadedMediaObject{}, err
	}
	defer tmp.Close()

	hasher := sha256.New()
	bytesWritten, err := io.Copy(io.MultiWriter(tmp, hasher), body)
	if err != nil {
		os.Remove(tmp.Name())
		return downloadedMediaObject{}, err
	}
	if info.ByteSize <= 0 {
		info.ByteSize = bytesWritten
	}
	if info.ContentType == "" {
		info.ContentType = detectFileContentType(tmp.Name(), "")
	}

	return downloadedMediaObject{
		ByteSize:    info.ByteSize,
		ContentType: info.ContentType,
		Path:        tmp.Name(),
		Sha256:      hex.EncodeToString(hasher.Sum(nil)),
	}, nil
}

func decodeImageFile(filePath string) (image.Image, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	return imaging.Decode(file, imaging.AutoOrientation(true))
}

func uploadImageDerivative(ctx context.Context, storage mediaObjectStorage, original *core.Record, img image.Image, variant string, maxDimension int) (processedMediaVariant, error) {
	resized := imaging.Fit(img, maxDimension, maxDimension, imaging.Lanczos)
	return uploadImageAsJPEGVariant(ctx, storage, original, resized, variant)
}

func uploadImageAsJPEGVariant(ctx context.Context, storage mediaObjectStorage, original *core.Record, img image.Image, variant string) (processedMediaVariant, error) {
	var buffer bytes.Buffer
	if err := imaging.Encode(&buffer, img, imaging.JPEG, imaging.JPEGQuality(mediaProcessingJPEGQuality)); err != nil {
		return processedMediaVariant{}, err
	}
	data := buffer.Bytes()
	objectKey := buildMediaDerivativeObjectKey(original.GetString("object_key"), variant)
	info, err := storage.PutObject(ctx, objectKey, "image/jpeg", bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return processedMediaVariant{}, err
	}
	width, height := imageDimensions(img)

	return processedMediaVariant{
		ByteSize:  int64(len(data)),
		ETag:      info.ETag,
		Height:    height,
		MimeType:  "image/jpeg",
		ObjectKey: objectKey,
		Sha256:    sha256Bytes(data),
		Variant:   variant,
		Width:     width,
	}, nil
}

func renderAndUploadFrameVariant(ctx context.Context, storage mediaObjectStorage, original *core.Record, inputPath string, variant string, maxDimension int, seekMs int) (processedMediaVariant, image.Image, error) {
	output, err := os.CreateTemp("", "infchat-frame-*.jpg")
	if err != nil {
		return processedMediaVariant{}, nil, err
	}
	outputPath := output.Name()
	output.Close()
	defer os.Remove(outputPath)

	if err := renderFrameJPEG(ctx, inputPath, outputPath, maxDimension, seekMs); err != nil {
		if seekMs > 0 {
			if fallbackErr := renderFrameJPEG(ctx, inputPath, outputPath, maxDimension, 0); fallbackErr != nil {
				return processedMediaVariant{}, nil, err
			}
		} else {
			return processedMediaVariant{}, nil, err
		}
	}
	data, err := os.ReadFile(outputPath)
	if err != nil {
		return processedMediaVariant{}, nil, err
	}
	img, err := decodeImageFile(outputPath)
	if err != nil {
		return processedMediaVariant{}, nil, err
	}
	objectKey := buildMediaDerivativeObjectKey(original.GetString("object_key"), variant)
	info, err := storage.PutObject(ctx, objectKey, "image/jpeg", bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return processedMediaVariant{}, nil, err
	}
	width, height := imageDimensions(img)

	return processedMediaVariant{
		ByteSize:  int64(len(data)),
		ETag:      info.ETag,
		Height:    height,
		MimeType:  "image/jpeg",
		ObjectKey: objectKey,
		Sha256:    sha256Bytes(data),
		Variant:   variant,
		Width:     width,
	}, img, nil
}

func renderFrameJPEG(ctx context.Context, inputPath string, outputPath string, maxDimension int, seekMs int) error {
	commandCtx, cancel := context.WithTimeout(ctx, mediaProcessingCommandTimeout)
	defer cancel()

	args := []string{"-y", "-hide_banner", "-loglevel", "error"}
	if seekMs > 0 {
		args = append(args, "-ss", formatFFmpegSeek(seekMs))
	}
	args = append(args,
		"-i", inputPath,
		"-frames:v", "1",
		"-vf", fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,setsar=1", maxDimension, maxDimension),
		"-q:v", "3",
		outputPath,
	)

	return runCommand(commandCtx, "ffmpeg", args...)
}

func probeVisualMediaFile(ctx context.Context, inputPath string) (probedVisualMedia, error) {
	commandCtx, cancel := context.WithTimeout(ctx, mediaProcessingCommandTimeout)
	defer cancel()

	output, err := exec.CommandContext(commandCtx, "ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", inputPath).CombinedOutput()
	if err != nil {
		return probedVisualMedia{}, fmt.Errorf("ffprobe failed: %w: %s", err, truncateString(string(output), 1000))
	}
	var probed ffprobeOutput
	if err := json.Unmarshal(output, &probed); err != nil {
		return probedVisualMedia{}, err
	}

	for _, stream := range probed.Streams {
		if stream.Width <= 0 || stream.Height <= 0 {
			continue
		}
		width := stream.Width
		height := stream.Height
		if mediaRotationRequiresDimensionSwap(stream.Tags, stream.SideDataList) {
			width, height = height, width
		}
		durationMs := durationStringToMilliseconds(stream.Duration)
		if durationMs == 0 {
			durationMs = durationStringToMilliseconds(probed.Format.Duration)
		}

		return probedVisualMedia{DurationMs: durationMs, Height: height, Width: width}, nil
	}

	return probedVisualMedia{}, fmt.Errorf("no visual stream was found")
}

func mediaRotationRequiresDimensionSwap(tags map[string]string, sideData []ffprobeSideData) bool {
	rotation := 0
	if raw := strings.TrimSpace(tags["rotate"]); raw != "" {
		rotation, _ = strconv.Atoi(raw)
	}
	for _, item := range sideData {
		if item.Rotation != 0 {
			rotation = item.Rotation
			break
		}
	}
	rotation = ((rotation % 360) + 360) % 360

	return rotation == 90 || rotation == 270
}

func runCommand(ctx context.Context, name string, args ...string) error {
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s failed: %w: %s", name, err, truncateString(string(output), 1000))
	}

	return nil
}

func buildMediaDerivativeObjectKey(originalObjectKey string, variant string) string {
	base := path.Dir(originalObjectKey)
	suffix := variant
	switch variant {
	case "thumbnail":
		suffix = "thumb_320"
	case "preview":
		suffix = "preview_1280"
	case "poster":
		suffix = "poster"
	}

	return path.Join(base, suffix)
}

func imageBlurhash(img image.Image) (string, error) {
	placeholder := imaging.Fit(img, 32, 32, imaging.Linear)

	return blurhash.Encode(4, 3, placeholder)
}

func imageDimensions(img image.Image) (int, int) {
	bounds := img.Bounds()

	return bounds.Dx(), bounds.Dy()
}

func verifyOriginalSha256(attachment *core.Record, actualSha256 string) error {
	expected := strings.ToLower(strings.TrimSpace(attachment.GetString("sha256")))
	if expected == "" || actualSha256 == "" || expected == actualSha256 {
		return nil
	}

	return fmt.Errorf("uploaded object sha256 does not match attachment metadata")
}

func effectiveOriginalMimeType(attachment *core.Record, original *core.Record, contentType string) string {
	for _, value := range []string{contentType, original.GetString("mime_type"), attachment.GetString("mime_type")} {
		value = strings.TrimSpace(value)
		if value != "" && value != "application/octet-stream" {
			return value
		}
	}

	return strings.TrimSpace(attachment.GetString("mime_type"))
}

func detectFileContentType(filePath string, fallback string) string {
	file, err := os.Open(filePath)
	if err != nil {
		return fallback
	}
	defer file.Close()

	buffer := make([]byte, 512)
	bytesRead, err := file.Read(buffer)
	if err != nil && !errors.Is(err, io.EOF) {
		return fallback
	}
	contentType := http.DetectContentType(buffer[:bytesRead])
	if contentType == "application/octet-stream" && fallback != "" {
		return fallback
	}

	return contentType
}

func durationStringToMilliseconds(value string) int {
	seconds, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || seconds <= 0 || math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return 0
	}

	return int(seconds*1000 + 0.5)
}

func formatFFmpegSeek(milliseconds int) string {
	if milliseconds <= 0 {
		return "0"
	}

	return fmt.Sprintf("%.3f", float64(milliseconds)/1000)
}

func sha256Bytes(data []byte) string {
	sum := sha256.Sum256(data)

	return hex.EncodeToString(sum[:])
}

func truncateString(value string, maxLength int) string {
	if len(value) <= maxLength {
		return value
	}

	return value[:maxLength]
}
