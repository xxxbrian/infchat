package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/security"
	"github.com/pocketbase/pocketbase/tools/types"
	"github.com/spf13/cast"
)

const (
	mediaUploadMaxAttachmentCount = 10
	mediaUploadSessionTTL         = 24 * time.Hour
	mediaUploadTenantID           = "default"
)

type startMediaUploadRequest struct {
	AttachmentKind     string `json:"attachmentKind" form:"attachmentKind"`
	Blurhash           string `json:"blurhash" form:"blurhash"`
	ByteSize           int64  `json:"byteSize" form:"byteSize"`
	ClientAttachmentId string `json:"clientAttachmentId" form:"clientAttachmentId"`
	ClientMessageId    string `json:"clientMessageId" form:"clientMessageId"`
	ConversationId     string `json:"conversationId" form:"conversationId"`
	DurationMs         int64  `json:"durationMs" form:"durationMs"`
	Height             int64  `json:"height" form:"height"`
	MimeType           string `json:"mimeType" form:"mimeType"`
	Ordinal            int64  `json:"ordinal" form:"ordinal"`
	OriginalName       string `json:"originalName" form:"originalName"`
	Sha256             string `json:"sha256" form:"sha256"`
	Variant            string `json:"variant" form:"variant"`
	Width              int64  `json:"width" form:"width"`
}

type signMediaUploadPartsRequest struct {
	PartNumbers []int `json:"partNumbers" form:"partNumbers"`
}

type completeMediaUploadRequest struct {
	Parts []completeMediaUploadPartRequest `json:"parts" form:"parts"`
}

type completeMediaUploadPartRequest struct {
	ETag       string `json:"etag" form:"etag"`
	PartNumber int    `json:"partNumber" form:"partNumber"`
}

type mediaUploadSessionResponse struct {
	AttachmentID string                  `json:"attachmentId"`
	ObjectKey    string                  `json:"objectKey"`
	Parts        []mediaUploadPartInfo   `json:"parts,omitempty"`
	Presigned    *mediaPresignedRequest  `json:"presigned,omitempty"`
	Profile      mediaStorageProfileInfo `json:"profile"`
	Session      *core.Record            `json:"session"`
	UploadID     string                  `json:"uploadId,omitempty"`
}

type mediaUploadPartInfo struct {
	ByteSize             int64                  `json:"byteSize"`
	ETag                 string                 `json:"etag,omitempty"`
	OffsetBytes          int64                  `json:"offsetBytes"`
	PartNumber           int                    `json:"partNumber"`
	Presigned            *mediaPresignedRequest `json:"presigned,omitempty"`
	SignedURLExpiresAt   string                 `json:"signedUrlExpiresAt,omitempty"`
	State                string                 `json:"state"`
	UploadPartRecordID   string                 `json:"uploadPartRecordId,omitempty"`
	ProviderReportedSize int64                  `json:"providerReportedSize,omitempty"`
}

type mediaStorageProfileInfo struct {
	ID                         string `json:"id"`
	Driver                     string `json:"driver"`
	MultipartPartSizeBytes     int64  `json:"multipartPartSizeBytes"`
	MultipartThresholdBytes    int64  `json:"multipartThresholdBytes"`
	MaxObjectSizeBytes         int64  `json:"maxObjectSizeBytes"`
	PresignTTLSeconds          int    `json:"presignTtlSeconds"`
	SupportsListParts          bool   `json:"supportsListParts"`
	SupportsMultipartUpload    bool   `json:"supportsMultipartUpload"`
	SupportsPresignedDownloads bool   `json:"supportsPresignedDownloads"`
}

func bindMediaUploadRoutes(group *router.RouterGroup[*core.RequestEvent]) {
	group.POST("/media/uploads/start", func(e *core.RequestEvent) error {
		data := startMediaUploadRequest{}
		if err := e.BindBody(&data); err != nil {
			return e.BadRequestError("Failed to read media upload data.", err)
		}

		result, err := startMediaUploadCommand(e.Request.Context(), e.App, e.Auth.Id, data)
		if err != nil {
			return err
		}

		return e.JSON(http.StatusOK, result)
	})

	group.POST("/media/uploads/{id}/sign-parts", func(e *core.RequestEvent) error {
		data := signMediaUploadPartsRequest{}
		if err := e.BindBody(&data); err != nil {
			return e.BadRequestError("Failed to read media upload part data.", err)
		}

		result, err := signMediaUploadPartsCommand(e.Request.Context(), e.App, e.Auth.Id, e.Request.PathValue("id"), data.PartNumbers)
		if err != nil {
			return err
		}

		return e.JSON(http.StatusOK, result)
	})

	group.GET("/media/uploads/{id}/parts", func(e *core.RequestEvent) error {
		result, err := listMediaUploadPartsCommand(e.Request.Context(), e.App, e.Auth.Id, e.Request.PathValue("id"))
		if err != nil {
			return err
		}

		return e.JSON(http.StatusOK, result)
	})

	group.GET("/media/uploads/{id}/status", func(e *core.RequestEvent) error {
		result, err := mediaUploadStatusCommand(e.App, e.Auth.Id, e.Request.PathValue("id"))
		if err != nil {
			return err
		}

		return e.JSON(http.StatusOK, result)
	})

	group.POST("/media/uploads/{id}/complete", func(e *core.RequestEvent) error {
		data := completeMediaUploadRequest{}
		if err := e.BindBody(&data); err != nil {
			return e.BadRequestError("Failed to read completed media upload data.", err)
		}

		result, err := completeMediaUploadCommand(e.Request.Context(), e.App, e.Auth.Id, e.Request.PathValue("id"), data.Parts)
		if err != nil {
			return err
		}

		return e.JSON(http.StatusOK, result)
	})

	group.POST("/media/uploads/{id}/abort", func(e *core.RequestEvent) error {
		result, err := abortMediaUploadCommand(e.Request.Context(), e.App, e.Auth.Id, e.Request.PathValue("id"))
		if err != nil {
			return err
		}

		return e.JSON(http.StatusOK, result)
	})
}

func startMediaUploadCommand(ctx context.Context, app core.App, userId string, data startMediaUploadRequest) (mediaUploadSessionResponse, error) {
	conversation, _, err := findActiveConversationMembership(app, data.ConversationId, userId)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	if strings.TrimSpace(data.ClientMessageId) == "" {
		return mediaUploadSessionResponse{}, router.NewBadRequestError("clientMessageId is required.", nil)
	}
	clientAttachmentId := strings.TrimSpace(data.ClientAttachmentId)
	if clientAttachmentId == "" {
		return mediaUploadSessionResponse{}, router.NewBadRequestError("clientAttachmentId is required.", nil)
	}
	if data.Ordinal < 0 {
		return mediaUploadSessionResponse{}, router.NewBadRequestError("ordinal must be positive.", nil)
	}
	storage, err := newMediaObjectStorageFromEnv(ctx)
	if err != nil {
		return mediaUploadSessionResponse{}, mediaStorageAPIError(err)
	}
	profile := storage.Profile()
	if data.ByteSize <= 0 {
		return mediaUploadSessionResponse{}, router.NewBadRequestError("byteSize is required.", nil)
	}
	if data.ByteSize > profile.MaxObjectSizeBytes {
		return mediaUploadSessionResponse{}, router.NewBadRequestError("Media object is too large.", nil)
	}

	attachmentKind, err := normalizeMediaAttachmentKind(data.AttachmentKind)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	variant, err := normalizeMediaUploadVariant(attachmentKind, data.Variant)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	if existing, err := findReusableMediaUploadSession(app, userId, conversation.Id, data.ClientMessageId, clientAttachmentId, variant); err == nil {
		return reusableMediaUploadSessionResponse(ctx, app, existing)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return mediaUploadSessionResponse{}, err
	}
	existingCount, err := countExistingUploadSessionsForMessage(app, userId, conversation.Id, data.ClientMessageId)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	if existingCount >= mediaUploadMaxAttachmentCount {
		return mediaUploadSessionResponse{}, router.NewBadRequestError("Too many attachments for one message.", nil)
	}
	mimeType := strings.TrimSpace(data.MimeType)
	if err := validateMediaUploadMIME(attachmentKind, mimeType); err != nil {
		return mediaUploadSessionResponse{}, err
	}
	attachmentID := newMediaAttachmentRecordId()
	objectKey := buildMediaObjectKey(conversation.Id, data.ClientMessageId, attachmentID, variant)
	uploadMode := "single"
	if profile.SupportsMultipartUpload && data.ByteSize >= profile.MultipartThresholdBytes {
		uploadMode = "multipart"
	}
	partSize := int64(0)
	partCount := 0
	if uploadMode == "multipart" {
		partSize = profile.MultipartPartSizeBytes
		partCount = int(math.Ceil(float64(data.ByteSize) / float64(partSize)))
		if partCount > 10000 {
			return mediaUploadSessionResponse{}, router.NewBadRequestError("Media object requires too many upload parts.", nil)
		}
	}

	uploadID := ""
	if uploadMode == "multipart" {
		uploadID, err = storage.CreateMultipartUpload(ctx, objectKey, mimeType)
		if err != nil {
			return mediaUploadSessionResponse{}, mediaStorageAPIError(err)
		}
	}

	var session *core.Record
	var parts []*core.Record
	err = app.RunInTransaction(func(txApp core.App) error {
		collection, err := txApp.FindCollectionByNameOrId("media_upload_sessions")
		if err != nil {
			return err
		}
		profileRecord, err := ensureStorageProfileRecord(txApp, profile)
		if err != nil {
			return err
		}

		session = core.NewRecord(collection)
		session.Set("conversation", conversation.Id)
		session.Set("user", userId)
		session.Set("client_message_id", strings.TrimSpace(data.ClientMessageId))
		session.Set("client_attachment_id", clientAttachmentId)
		session.Set("attachment_id", attachmentID)
		session.Set("attachment_kind", attachmentKind)
		session.Set("variant", variant)
		session.Set("ordinal", data.Ordinal)
		session.Set("storage_profile", profileRecord.Id)
		session.Set("object_key", objectKey)
		session.Set("upload_id", uploadID)
		session.Set("upload_mode", uploadMode)
		session.Set("original_name", strings.TrimSpace(data.OriginalName))
		session.Set("mime_type", mimeType)
		session.Set("byte_size", data.ByteSize)
		session.Set("width", data.Width)
		session.Set("height", data.Height)
		session.Set("duration_ms", data.DurationMs)
		session.Set("sha256", strings.TrimSpace(data.Sha256))
		session.Set("blurhash", strings.TrimSpace(data.Blurhash))
		session.Set("part_size", partSize)
		session.Set("part_count", partCount)
		session.Set("state", "pending")
		session.Set("expires_at", types.NowDateTime().Add(mediaUploadSessionTTL))
		if err := txApp.Save(session); err != nil {
			return err
		}

		if uploadMode == "multipart" {
			parts, err = createMediaUploadPartRecords(txApp, session.Id, data.ByteSize, partSize, partCount)
			if err != nil {
				return err
			}
		}

		return nil
	})
	if err != nil {
		if uploadID != "" {
			_ = storage.AbortMultipartUpload(ctx, objectKey, uploadID)
		}
		return mediaUploadSessionResponse{}, err
	}

	response := mediaUploadSessionResponse{
		AttachmentID: attachmentID,
		ObjectKey:    objectKey,
		Profile:      storageProfileResponse(profile),
		Session:      session,
		UploadID:     uploadID,
	}
	if uploadMode == "single" {
		presigned, err := storage.PresignPutObject(ctx, objectKey, mimeType, profile.PresignTTL)
		if err != nil {
			return mediaUploadSessionResponse{}, mediaStorageAPIError(err)
		}
		response.Presigned = &presigned
		return response, nil
	}

	response.Parts = mediaUploadPartInfoFromRecords(parts, nil, nil)

	return response, nil
}

func reusableMediaUploadSessionResponse(ctx context.Context, app core.App, session *core.Record) (mediaUploadSessionResponse, error) {
	storage, err := newMediaObjectStorageFromEnv(ctx)
	if err != nil {
		return mediaUploadSessionResponse{}, mediaStorageAPIError(err)
	}
	if session.GetString("upload_mode") == "single" && !mediaUploadSessionTerminal(session) {
		presigned, err := storage.PresignPutObject(ctx, session.GetString("object_key"), session.GetString("mime_type"), storage.Profile().PresignTTL)
		if err != nil {
			return mediaUploadSessionResponse{}, mediaStorageAPIError(err)
		}
		response := mediaUploadStatusResponse(app, session, storage.Profile(), nil)
		response.Presigned = &presigned

		return response, nil
	}

	return mediaUploadStatusResponse(app, session, storage.Profile(), nil), nil
}

func signMediaUploadPartsCommand(ctx context.Context, app core.App, userId string, sessionId string, requestedPartNumbers []int) (mediaUploadSessionResponse, error) {
	session, storage, err := findMediaUploadSessionForUser(ctx, app, userId, sessionId)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	if session.GetString("upload_mode") != "multipart" || strings.TrimSpace(session.GetString("upload_id")) == "" {
		return mediaUploadSessionResponse{}, router.NewBadRequestError("Upload session is not multipart.", nil)
	}
	if mediaUploadSessionExpired(session) {
		return mediaUploadSessionResponse{}, router.NewBadRequestError("Upload session has expired.", nil)
	}

	partNumbers, err := normalizeRequestedPartNumbers(requestedPartNumbers, session.GetInt("part_count"))
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	partByNumber, err := mediaUploadPartRecordsByNumber(app, session.Id)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	parts := make([]*core.Record, 0, len(partNumbers))
	presignedByPart := make(map[int]mediaPresignedRequest, len(partNumbers))
	expiresAt := types.NowDateTime().Add(storage.Profile().PresignTTL)
	for _, partNumber := range partNumbers {
		part := partByNumber[partNumber]
		if part == nil {
			return mediaUploadSessionResponse{}, router.NewBadRequestError("Upload part was not found.", nil)
		}
		presigned, err := storage.PresignUploadPart(ctx, session.GetString("object_key"), session.GetString("upload_id"), int32(partNumber), storage.Profile().PresignTTL)
		if err != nil {
			return mediaUploadSessionResponse{}, mediaStorageAPIError(err)
		}
		if part.GetString("state") != "uploaded" {
			part.Set("state", "signed")
		}
		part.Set("signed_url_expires_at", expiresAt)
		if err := app.Save(part); err != nil {
			return mediaUploadSessionResponse{}, err
		}
		parts = append(parts, part)
		presignedByPart[partNumber] = presigned
	}
	if session.GetString("state") == "pending" {
		session.Set("state", "uploading")
		if err := app.Save(session); err != nil {
			return mediaUploadSessionResponse{}, err
		}
	}

	return mediaUploadSessionResponse{
		AttachmentID: session.GetString("attachment_id"),
		ObjectKey:    session.GetString("object_key"),
		Parts:        mediaUploadPartInfoFromRecords(parts, presignedByPart, nil),
		Profile:      storageProfileResponse(storage.Profile()),
		Session:      session,
		UploadID:     session.GetString("upload_id"),
	}, nil
}

func listMediaUploadPartsCommand(ctx context.Context, app core.App, userId string, sessionId string) (mediaUploadSessionResponse, error) {
	session, storage, err := findMediaUploadSessionForUser(ctx, app, userId, sessionId)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	if session.GetString("upload_mode") != "multipart" {
		return mediaUploadStatusResponse(app, session, storage.Profile(), nil), nil
	}

	parts, err := mediaUploadPartRecords(app, session.Id)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	providerParts := map[int]uploadedMediaPart{}
	if storage.Profile().SupportsListParts && session.GetString("upload_id") != "" && !mediaUploadSessionTerminal(session) {
		uploadedParts, err := storage.ListParts(ctx, session.GetString("object_key"), session.GetString("upload_id"))
		if err != nil {
			return mediaUploadSessionResponse{}, mediaStorageAPIError(err)
		}
		for _, uploadedPart := range uploadedParts {
			providerParts[int(uploadedPart.PartNumber)] = uploadedPart
		}
		if err := reconcileProviderUploadParts(app, parts, providerParts); err != nil {
			return mediaUploadSessionResponse{}, err
		}
	}

	return mediaUploadStatusResponse(app, session, storage.Profile(), providerParts), nil
}

func mediaUploadStatusCommand(app core.App, userId string, sessionId string) (mediaUploadSessionResponse, error) {
	session, err := findMediaUploadSessionRecordForUser(app, userId, sessionId)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	if _, _, err := findActiveConversationMembership(app, session.GetString("conversation"), userId); err != nil {
		return mediaUploadSessionResponse{}, err
	}
	profile, err := storageProfileFromUploadSession(app, session)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}

	return mediaUploadStatusResponse(app, session, profile, nil), nil
}

func completeMediaUploadCommand(ctx context.Context, app core.App, userId string, sessionId string, partRequests []completeMediaUploadPartRequest) (mediaUploadSessionResponse, error) {
	session, storage, err := findMediaUploadSessionForUser(ctx, app, userId, sessionId)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	if mediaUploadSessionExpired(session) {
		return mediaUploadSessionResponse{}, router.NewBadRequestError("Upload session has expired.", nil)
	}
	if mediaUploadSessionTerminal(session) {
		return mediaUploadStatusResponse(app, session, storage.Profile(), nil), nil
	}

	var info mediaStorageObjectInfo
	if session.GetString("upload_mode") == "multipart" {
		completedParts, err := normalizeCompletedParts(partRequests, session.GetInt("part_count"))
		if err != nil {
			return mediaUploadSessionResponse{}, err
		}
		session.Set("state", "completing")
		if err := app.Save(session); err != nil {
			return mediaUploadSessionResponse{}, err
		}
		info, err = storage.CompleteMultipartUpload(ctx, session.GetString("object_key"), session.GetString("upload_id"), completedParts)
		if err != nil {
			if completedInfo, headErr := storage.HeadObject(ctx, session.GetString("object_key")); headErr == nil && uploadObjectSizeMatches(session, completedInfo) {
				info = completedInfo
			} else {
				session.Set("state", "failed")
				session.Set("last_error", err.Error())
				_ = app.Save(session)
				return mediaUploadSessionResponse{}, mediaStorageAPIError(err)
			}
		}
		if err := markCompletedUploadParts(app, session.Id, completedParts); err != nil {
			return mediaUploadSessionResponse{}, err
		}
	} else {
		info, err = storage.HeadObject(ctx, session.GetString("object_key"))
		if err != nil {
			session.Set("state", "failed")
			session.Set("last_error", err.Error())
			_ = app.Save(session)
			return mediaUploadSessionResponse{}, mediaStorageAPIError(err)
		}
	}
	if !uploadObjectSizeMatches(session, info) {
		session.Set("state", "failed")
		session.Set("last_error", "uploaded object size does not match the upload session")
		_ = app.Save(session)
		return mediaUploadSessionResponse{}, router.NewBadRequestError("Uploaded object size does not match the upload session.", nil)
	}

	session.Set("state", "completed")
	session.Set("completed_at", types.NowDateTime())
	session.Set("last_error", "")
	if info.ContentType != "" && session.GetString("mime_type") == "" {
		session.Set("mime_type", info.ContentType)
	}
	if err := app.Save(session); err != nil {
		return mediaUploadSessionResponse{}, err
	}

	return mediaUploadStatusResponse(app, session, storage.Profile(), nil), nil
}

func abortMediaUploadCommand(ctx context.Context, app core.App, userId string, sessionId string) (mediaUploadSessionResponse, error) {
	session, storage, err := findMediaUploadSessionForUser(ctx, app, userId, sessionId)
	if err != nil {
		return mediaUploadSessionResponse{}, err
	}
	if session.GetString("state") == "completed" {
		return mediaUploadStatusResponse(app, session, storage.Profile(), nil), nil
	}
	if session.GetString("state") == "aborted" {
		return mediaUploadStatusResponse(app, session, storage.Profile(), nil), nil
	}
	if session.GetString("upload_mode") == "multipart" && session.GetString("upload_id") != "" && session.GetString("state") != "completed" {
		if err := storage.AbortMultipartUpload(ctx, session.GetString("object_key"), session.GetString("upload_id")); err != nil {
			return mediaUploadSessionResponse{}, mediaStorageAPIError(err)
		}
	} else if session.GetString("upload_mode") == "single" && session.GetString("state") != "completed" {
		_ = storage.DeleteObject(ctx, session.GetString("object_key"))
	}

	session.Set("state", "aborted")
	if err := app.Save(session); err != nil {
		return mediaUploadSessionResponse{}, err
	}

	return mediaUploadStatusResponse(app, session, storage.Profile(), nil), nil
}

func createMediaUploadPartRecords(app core.App, sessionId string, byteSize int64, partSize int64, partCount int) ([]*core.Record, error) {
	collection, err := app.FindCollectionByNameOrId("media_upload_parts")
	if err != nil {
		return nil, err
	}

	parts := make([]*core.Record, 0, partCount)
	for partNumber := 1; partNumber <= partCount; partNumber++ {
		offset := int64(partNumber-1) * partSize
		length := partSize
		if remaining := byteSize - offset; remaining < length {
			length = remaining
		}
		part := core.NewRecord(collection)
		part.Set("upload_session", sessionId)
		part.Set("part_number", partNumber)
		part.Set("offset_bytes", offset)
		part.Set("byte_size", length)
		part.Set("state", "pending")
		if err := app.Save(part); err != nil {
			return nil, err
		}
		parts = append(parts, part)
	}

	return parts, nil
}

func ensureStorageProfileRecord(app core.App, profile mediaStorageProfile) (*core.Record, error) {
	if existing, err := app.FindFirstRecordByFilter("storage_profiles", "name={:name}", dbx.Params{"name": profile.ID}); err == nil {
		setStorageProfileRecordFields(existing, profile)
		return existing, app.Save(existing)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	collection, err := app.FindCollectionByNameOrId("storage_profiles")
	if err != nil {
		return nil, err
	}
	record := core.NewRecord(collection)
	setStorageProfileRecordFields(record, profile)

	return record, app.Save(record)
}

func setStorageProfileRecordFields(record *core.Record, profile mediaStorageProfile) {
	capabilitiesJSON, _ := json.Marshal(map[string]any{
		"listParts":          profile.SupportsListParts,
		"multipartUpload":    profile.SupportsMultipartUpload,
		"presignedDownloads": profile.SupportsPresignedDownloads,
	})
	record.Set("name", profile.ID)
	record.Set("driver", profile.Driver)
	record.Set("status", "active")
	record.Set("endpoint", profile.Endpoint)
	record.Set("region", profile.Region)
	record.Set("bucket", profile.Bucket)
	record.Set("public_base_url", profile.PublicBaseURL)
	record.Set("force_path_style", profile.ForcePathStyle)
	record.Set("presign_ttl_seconds", int(profile.PresignTTL.Seconds()))
	record.Set("multipart_threshold_bytes", profile.MultipartThresholdBytes)
	record.Set("multipart_part_size_bytes", profile.MultipartPartSizeBytes)
	record.Set("max_object_size_bytes", profile.MaxObjectSizeBytes)
	record.Set("capabilities_json", string(capabilitiesJSON))
}

func findMediaUploadSessionForUser(ctx context.Context, app core.App, userId string, sessionId string) (*core.Record, mediaObjectStorage, error) {
	session, err := findMediaUploadSessionRecordForUser(app, userId, sessionId)
	if err != nil {
		return nil, nil, err
	}
	if _, _, err := findActiveConversationMembership(app, session.GetString("conversation"), userId); err != nil {
		return nil, nil, err
	}
	storage, err := newMediaObjectStorageFromEnv(ctx)
	if err != nil {
		return nil, nil, mediaStorageAPIError(err)
	}

	return session, storage, nil
}

func findMediaUploadSessionRecordForUser(app core.App, userId string, sessionId string) (*core.Record, error) {
	if strings.TrimSpace(sessionId) == "" {
		return nil, router.NewBadRequestError("Upload session is required.", nil)
	}
	session, err := app.FindRecordById("media_upload_sessions", strings.TrimSpace(sessionId))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, router.NewBadRequestError("Upload session was not found.", nil)
		}
		return nil, err
	}
	if session.GetString("user") != userId {
		return nil, router.NewForbiddenError("You cannot access this upload session.", nil)
	}

	return session, nil
}

func mediaUploadPartRecords(app core.App, sessionId string) ([]*core.Record, error) {
	return app.FindRecordsByFilter("media_upload_parts", "upload_session={:session}", "part_number", 0, 0, dbx.Params{"session": sessionId})
}

func mediaUploadPartRecordsByNumber(app core.App, sessionId string) (map[int]*core.Record, error) {
	parts, err := mediaUploadPartRecords(app, sessionId)
	if err != nil {
		return nil, err
	}
	byNumber := make(map[int]*core.Record, len(parts))
	for _, part := range parts {
		byNumber[part.GetInt("part_number")] = part
	}

	return byNumber, nil
}

func mediaUploadStatusResponse(app core.App, session *core.Record, profile mediaStorageProfile, providerParts map[int]uploadedMediaPart) mediaUploadSessionResponse {
	response := mediaUploadSessionResponse{
		AttachmentID: session.GetString("attachment_id"),
		ObjectKey:    session.GetString("object_key"),
		Profile:      storageProfileResponse(profile),
		Session:      session,
		UploadID:     session.GetString("upload_id"),
	}
	if session.GetString("upload_mode") == "multipart" {
		parts, err := mediaUploadPartRecords(app, session.Id)
		if err == nil {
			response.Parts = mediaUploadPartInfoFromRecords(parts, nil, providerParts)
		}
	}

	return response
}

func mediaUploadPartInfoFromRecords(parts []*core.Record, presignedByPart map[int]mediaPresignedRequest, providerParts map[int]uploadedMediaPart) []mediaUploadPartInfo {
	result := make([]mediaUploadPartInfo, 0, len(parts))
	for _, part := range parts {
		partNumber := part.GetInt("part_number")
		info := mediaUploadPartInfo{
			ByteSize:           recordInt64(part, "byte_size"),
			ETag:               part.GetString("etag"),
			OffsetBytes:        recordInt64(part, "offset_bytes"),
			PartNumber:         partNumber,
			SignedURLExpiresAt: part.GetDateTime("signed_url_expires_at").String(),
			State:              part.GetString("state"),
			UploadPartRecordID: part.Id,
		}
		if presigned, ok := presignedByPart[partNumber]; ok {
			info.Presigned = &presigned
		}
		if providerPart, ok := providerParts[partNumber]; ok {
			info.ProviderReportedSize = providerPart.ByteSize
			if info.ETag == "" {
				info.ETag = providerPart.ETag
			}
		}
		result = append(result, info)
	}

	return result
}

func countExistingUploadSessionsForMessage(app core.App, userId string, conversationId string, clientMessageId string) (int, error) {
	sessions, err := app.FindRecordsByFilter(
		"media_upload_sessions",
		"user={:user} && conversation={:conversation} && client_message_id={:clientMessageId} && state!='aborted'",
		"",
		mediaUploadMaxAttachmentCount+1,
		0,
		dbx.Params{"clientMessageId": strings.TrimSpace(clientMessageId), "conversation": conversationId, "user": userId},
	)
	if err != nil {
		return 0, err
	}

	attachmentIds := map[string]struct{}{}
	for _, session := range sessions {
		clientAttachmentId := strings.TrimSpace(session.GetString("client_attachment_id"))
		if clientAttachmentId == "" {
			clientAttachmentId = session.GetString("attachment_id")
		}
		attachmentIds[clientAttachmentId] = struct{}{}
	}

	return len(attachmentIds), nil
}

func findReusableMediaUploadSession(app core.App, userId string, conversationId string, clientMessageId string, clientAttachmentId string, variant string) (*core.Record, error) {
	return app.FindFirstRecordByFilter(
		"media_upload_sessions",
		"user={:user} && conversation={:conversation} && client_message_id={:clientMessageId} && client_attachment_id={:clientAttachmentId} && variant={:variant} && state!='aborted'",
		dbx.Params{"clientAttachmentId": strings.TrimSpace(clientAttachmentId), "clientMessageId": strings.TrimSpace(clientMessageId), "conversation": conversationId, "user": userId, "variant": variant},
	)
}

func normalizeRequestedPartNumbers(requested []int, partCount int) ([]int, error) {
	if partCount <= 0 {
		return nil, router.NewBadRequestError("Upload session has no parts.", nil)
	}
	if len(requested) == 0 {
		requested = make([]int, 0, partCount)
		for partNumber := 1; partNumber <= partCount; partNumber++ {
			requested = append(requested, partNumber)
		}
	}
	if len(requested) > 1000 {
		return nil, router.NewBadRequestError("Too many upload parts requested.", nil)
	}
	seen := map[int]struct{}{}
	result := make([]int, 0, len(requested))
	for _, partNumber := range requested {
		if partNumber < 1 || partNumber > partCount {
			return nil, router.NewBadRequestError("Upload part number is out of range.", nil)
		}
		if _, ok := seen[partNumber]; ok {
			continue
		}
		seen[partNumber] = struct{}{}
		result = append(result, partNumber)
	}
	sort.Ints(result)

	return result, nil
}

func normalizeCompletedParts(parts []completeMediaUploadPartRequest, partCount int) ([]completedMediaUploadPart, error) {
	if partCount <= 0 {
		return nil, router.NewBadRequestError("Upload session has no parts.", nil)
	}
	if len(parts) != partCount {
		return nil, router.NewBadRequestError("Completed upload parts are incomplete.", nil)
	}
	seen := map[int]struct{}{}
	completed := make([]completedMediaUploadPart, 0, len(parts))
	for _, part := range parts {
		etag := strings.TrimSpace(part.ETag)
		if part.PartNumber < 1 || part.PartNumber > partCount || etag == "" {
			return nil, router.NewBadRequestError("Completed upload part is invalid.", nil)
		}
		if _, ok := seen[part.PartNumber]; ok {
			return nil, router.NewBadRequestError("Completed upload parts contain duplicates.", nil)
		}
		seen[part.PartNumber] = struct{}{}
		completed = append(completed, completedMediaUploadPart{PartNumber: int32(part.PartNumber), ETag: etag})
	}
	sort.Slice(completed, func(i int, j int) bool { return completed[i].PartNumber < completed[j].PartNumber })

	return completed, nil
}

func markCompletedUploadParts(app core.App, sessionId string, completedParts []completedMediaUploadPart) error {
	partByNumber, err := mediaUploadPartRecordsByNumber(app, sessionId)
	if err != nil {
		return err
	}
	for _, completedPart := range completedParts {
		part := partByNumber[int(completedPart.PartNumber)]
		if part == nil {
			return router.NewBadRequestError("Upload part was not found.", nil)
		}
		part.Set("etag", completedPart.ETag)
		part.Set("state", "uploaded")
		if err := app.Save(part); err != nil {
			return err
		}
	}

	return nil
}

func reconcileProviderUploadParts(app core.App, parts []*core.Record, providerParts map[int]uploadedMediaPart) error {
	for _, part := range parts {
		providerPart, ok := providerParts[part.GetInt("part_number")]
		if !ok || providerPart.ETag == "" {
			continue
		}
		part.Set("etag", providerPart.ETag)
		part.Set("state", "uploaded")
		if err := app.Save(part); err != nil {
			return err
		}
	}

	return nil
}

func normalizeMediaAttachmentKind(kind string) (string, error) {
	switch strings.TrimSpace(kind) {
	case "image", "video", "file", "voice":
		return strings.TrimSpace(kind), nil
	default:
		return "", router.NewBadRequestError("Attachment kind is invalid.", nil)
	}
}

func normalizeMediaUploadVariant(attachmentKind string, variant string) (string, error) {
	variant = strings.TrimSpace(variant)
	if variant == "" {
		variant = "original"
	}
	switch variant {
	case "thumbnail", "preview", "original", "poster":
	default:
		return "", router.NewBadRequestError("Attachment variant is invalid.", nil)
	}
	if attachmentKind == "file" && variant != "original" {
		return "", router.NewBadRequestError("File uploads only support the original variant.", nil)
	}
	if attachmentKind == "voice" && variant != "original" {
		return "", router.NewBadRequestError("Voice uploads only support the original variant.", nil)
	}

	return variant, nil
}

func validateMediaUploadMIME(kind string, mimeType string) error {
	mimeType = strings.ToLower(strings.TrimSpace(mimeType))
	if mimeType == "" {
		return router.NewBadRequestError("mimeType is required.", nil)
	}
	switch kind {
	case "image":
		if !strings.HasPrefix(mimeType, "image/") {
			return router.NewBadRequestError("Image upload must use an image MIME type.", nil)
		}
	case "video":
		if !strings.HasPrefix(mimeType, "video/") {
			return router.NewBadRequestError("Video upload must use a video MIME type.", nil)
		}
	case "voice":
		if !strings.HasPrefix(mimeType, "audio/") {
			return router.NewBadRequestError("Voice upload must use an audio MIME type.", nil)
		}
	}

	return nil
}

func newMediaAttachmentRecordId() string {
	return "r" + strings.ToLower(security.RandomString(14))
}

func buildMediaObjectKey(conversationId string, clientMessageId string, attachmentId string, variant string) string {
	now := time.Now().UTC()
	safeClientMessageId := sanitizeObjectKeySegment(clientMessageId)
	if safeClientMessageId == "" {
		safeClientMessageId = security.RandomString(12)
	}

	return path.Join("media", mediaUploadTenantID, sanitizeObjectKeySegment(conversationId), now.Format("2006"), now.Format("01"), safeClientMessageId, sanitizeObjectKeySegment(attachmentId), sanitizeObjectKeySegment(variant))
}

func sanitizeObjectKeySegment(value string) string {
	value = strings.TrimSpace(value)
	var builder strings.Builder
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || (char >= '0' && char <= '9') || char == '-' || char == '_' || char == '.' {
			builder.WriteRune(char)
		}
	}

	return builder.String()
}

func mediaUploadSessionExpired(session *core.Record) bool {
	expiresAt := session.GetDateTime("expires_at")

	return !expiresAt.IsZero() && time.Now().After(expiresAt.Time())
}

func mediaUploadSessionTerminal(session *core.Record) bool {
	switch session.GetString("state") {
	case "completed", "aborted", "failed", "expired":
		return true
	default:
		return false
	}
}

func storageProfileFromUploadSession(app core.App, session *core.Record) (mediaStorageProfile, error) {
	profileRecord, err := app.FindRecordById("storage_profiles", session.GetString("storage_profile"))
	if err != nil {
		return storageProfileFromSessionRecord(session), nil
	}
	presignTTL := time.Duration(profileRecord.GetInt("presign_ttl_seconds")) * time.Second
	if presignTTL <= 0 {
		presignTTL = mediaStorageDefaultPresignTTLSeconds * time.Second
	}
	multipartThresholdBytes := recordInt64(profileRecord, "multipart_threshold_bytes")
	if multipartThresholdBytes <= 0 {
		multipartThresholdBytes = mediaStorageDefaultMultipartThresholdBytes
	}
	multipartPartSizeBytes := recordInt64(profileRecord, "multipart_part_size_bytes")
	if multipartPartSizeBytes <= 0 {
		multipartPartSizeBytes = mediaStorageDefaultMultipartPartSizeBytes
	}
	maxObjectSizeBytes := recordInt64(profileRecord, "max_object_size_bytes")
	if maxObjectSizeBytes <= 0 {
		maxObjectSizeBytes = mediaStorageDefaultMaxObjectSizeBytes
	}
	driver := profileRecord.GetString("driver")
	if driver == "" {
		driver = "s3"
	}

	return mediaStorageProfile{
		ID:                         profileRecord.GetString("name"),
		Driver:                     driver,
		Endpoint:                   profileRecord.GetString("endpoint"),
		Region:                     profileRecord.GetString("region"),
		Bucket:                     profileRecord.GetString("bucket"),
		PublicBaseURL:              profileRecord.GetString("public_base_url"),
		ForcePathStyle:             profileRecord.GetBool("force_path_style"),
		PresignTTL:                 presignTTL,
		MultipartThresholdBytes:    multipartThresholdBytes,
		MultipartPartSizeBytes:     multipartPartSizeBytes,
		MaxObjectSizeBytes:         maxObjectSizeBytes,
		SupportsListParts:          true,
		SupportsMultipartUpload:    session.GetString("upload_mode") == "multipart",
		SupportsPresignedDownloads: true,
	}, nil
}

func storageProfileFromSessionRecord(session *core.Record) mediaStorageProfile {
	return mediaStorageProfile{
		ID:                         session.GetString("storage_profile"),
		Driver:                     "s3",
		PresignTTL:                 mediaStorageDefaultPresignTTLSeconds * time.Second,
		MultipartThresholdBytes:    recordInt64(session, "part_size"),
		MultipartPartSizeBytes:     recordInt64(session, "part_size"),
		MaxObjectSizeBytes:         mediaStorageDefaultMaxObjectSizeBytes,
		SupportsListParts:          true,
		SupportsMultipartUpload:    session.GetString("upload_mode") == "multipart",
		SupportsPresignedDownloads: true,
	}
}

func recordInt64(record *core.Record, field string) int64 {
	return cast.ToInt64(record.Get(field))
}

func uploadObjectSizeMatches(session *core.Record, info mediaStorageObjectInfo) bool {
	expectedSize := recordInt64(session, "byte_size")

	return expectedSize <= 0 || info.ByteSize <= 0 || expectedSize == info.ByteSize
}

func storageProfileResponse(profile mediaStorageProfile) mediaStorageProfileInfo {
	return mediaStorageProfileInfo{
		ID:                         profile.ID,
		Driver:                     profile.Driver,
		MultipartPartSizeBytes:     profile.MultipartPartSizeBytes,
		MultipartThresholdBytes:    profile.MultipartThresholdBytes,
		MaxObjectSizeBytes:         profile.MaxObjectSizeBytes,
		PresignTTLSeconds:          int(profile.PresignTTL.Seconds()),
		SupportsListParts:          profile.SupportsListParts,
		SupportsMultipartUpload:    profile.SupportsMultipartUpload,
		SupportsPresignedDownloads: profile.SupportsPresignedDownloads,
	}
}

func mediaStorageAPIError(err error) error {
	if errors.Is(err, errMediaStorageNotConfigured) {
		return router.NewApiError(http.StatusServiceUnavailable, "Media storage is not configured.", err)
	}

	return err
}
