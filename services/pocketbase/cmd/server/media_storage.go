package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const (
	mediaStorageDefaultPresignTTLSeconds       = 15 * 60
	mediaStorageMinMultipartPartSizeBytes      = 5 * 1024 * 1024
	mediaStorageDefaultMultipartThresholdBytes = 8 * 1024 * 1024
	mediaStorageDefaultMultipartPartSizeBytes  = 8 * 1024 * 1024
	mediaStorageDefaultMaxObjectSizeBytes      = 2 * 1024 * 1024 * 1024
)

var errMediaStorageNotConfigured = errors.New("media storage is not configured")

type mediaStorageProfile struct {
	ID                         string
	Driver                     string
	Endpoint                   string
	PresignEndpoint            string
	Region                     string
	Bucket                     string
	PublicBaseURL              string
	ForcePathStyle             bool
	PresignTTL                 time.Duration
	MultipartThresholdBytes    int64
	MultipartPartSizeBytes     int64
	MaxObjectSizeBytes         int64
	SupportsListParts          bool
	SupportsMultipartUpload    bool
	SupportsPresignedDownloads bool
}

type mediaPresignedRequest struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Expires int               `json:"expires"`
}

type mediaStorageObjectInfo struct {
	ByteSize    int64
	ContentType string
	ETag        string
}

type completedMediaUploadPart struct {
	PartNumber int32
	ETag       string
}

type uploadedMediaPart struct {
	PartNumber int32
	ByteSize   int64
	ETag       string
}

type mediaObjectStorage interface {
	Profile() mediaStorageProfile
	HeadObject(ctx context.Context, objectKey string) (mediaStorageObjectInfo, error)
	PresignPutObject(ctx context.Context, objectKey string, contentType string, expires time.Duration) (mediaPresignedRequest, error)
	PresignGetObject(ctx context.Context, objectKey string, expires time.Duration) (mediaPresignedRequest, error)
	CreateMultipartUpload(ctx context.Context, objectKey string, contentType string) (string, error)
	PresignUploadPart(ctx context.Context, objectKey string, uploadID string, partNumber int32, expires time.Duration) (mediaPresignedRequest, error)
	ListParts(ctx context.Context, objectKey string, uploadID string) ([]uploadedMediaPart, error)
	CompleteMultipartUpload(ctx context.Context, objectKey string, uploadID string, parts []completedMediaUploadPart) (mediaStorageObjectInfo, error)
	AbortMultipartUpload(ctx context.Context, objectKey string, uploadID string) error
	DeleteObject(ctx context.Context, objectKey string) error
}

type s3MediaObjectStorage struct {
	profile mediaStorageProfile
	client  *s3.Client
	presign *s3.PresignClient
}

func newMediaObjectStorageFromEnv(ctx context.Context) (mediaObjectStorage, error) {
	profile := mediaStorageProfile{
		ID:                         strings.TrimSpace(os.Getenv("INFCHAT_MEDIA_STORAGE_PROFILE_ID")),
		Driver:                     envString("INFCHAT_MEDIA_STORAGE_DRIVER", "s3"),
		Endpoint:                   strings.TrimSpace(os.Getenv("INFCHAT_MEDIA_S3_ENDPOINT")),
		PresignEndpoint:            strings.TrimSpace(os.Getenv("INFCHAT_MEDIA_S3_PRESIGN_ENDPOINT")),
		Region:                     envString("INFCHAT_MEDIA_S3_REGION", "auto"),
		Bucket:                     strings.TrimSpace(os.Getenv("INFCHAT_MEDIA_S3_BUCKET")),
		PublicBaseURL:              strings.TrimRight(strings.TrimSpace(os.Getenv("INFCHAT_MEDIA_PUBLIC_BASE_URL")), "/"),
		ForcePathStyle:             envBool("INFCHAT_MEDIA_S3_FORCE_PATH_STYLE", false),
		PresignTTL:                 time.Duration(envInt64("INFCHAT_MEDIA_PRESIGN_TTL_SECONDS", mediaStorageDefaultPresignTTLSeconds)) * time.Second,
		MultipartThresholdBytes:    envInt64("INFCHAT_MEDIA_MULTIPART_THRESHOLD_BYTES", mediaStorageDefaultMultipartThresholdBytes),
		MultipartPartSizeBytes:     envInt64("INFCHAT_MEDIA_MULTIPART_PART_SIZE_BYTES", mediaStorageDefaultMultipartPartSizeBytes),
		MaxObjectSizeBytes:         envInt64("INFCHAT_MEDIA_MAX_OBJECT_SIZE_BYTES", mediaStorageDefaultMaxObjectSizeBytes),
		SupportsListParts:          envBool("INFCHAT_MEDIA_S3_SUPPORTS_LIST_PARTS", true),
		SupportsMultipartUpload:    envBool("INFCHAT_MEDIA_S3_SUPPORTS_MULTIPART", true),
		SupportsPresignedDownloads: true,
	}
	if profile.ID == "" {
		profile.ID = "default"
	}
	if profile.Driver != "s3" {
		return nil, fmt.Errorf("unsupported media storage driver %q", profile.Driver)
	}
	if profile.Bucket == "" {
		return nil, errMediaStorageNotConfigured
	}
	if profile.PresignTTL <= 0 {
		profile.PresignTTL = mediaStorageDefaultPresignTTLSeconds * time.Second
	}
	if profile.MultipartPartSizeBytes < mediaStorageMinMultipartPartSizeBytes {
		profile.MultipartPartSizeBytes = mediaStorageDefaultMultipartPartSizeBytes
	}
	if profile.MultipartThresholdBytes <= 0 {
		profile.MultipartThresholdBytes = mediaStorageDefaultMultipartThresholdBytes
	}
	if profile.MaxObjectSizeBytes <= 0 {
		profile.MaxObjectSizeBytes = mediaStorageDefaultMaxObjectSizeBytes
	}

	accessKey := strings.TrimSpace(os.Getenv("INFCHAT_MEDIA_S3_ACCESS_KEY_ID"))
	secretKey := strings.TrimSpace(os.Getenv("INFCHAT_MEDIA_S3_SECRET_ACCESS_KEY"))
	if accessKey == "" || secretKey == "" {
		return nil, fmt.Errorf("%w: INFCHAT_MEDIA_S3_ACCESS_KEY_ID and INFCHAT_MEDIA_S3_SECRET_ACCESS_KEY are required", errMediaStorageNotConfigured)
	}

	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(profile.Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKey, secretKey, strings.TrimSpace(os.Getenv("INFCHAT_MEDIA_S3_SESSION_TOKEN")))),
	)
	if err != nil {
		return nil, err
	}

	client := s3.NewFromConfig(cfg, func(options *s3.Options) {
		if profile.Endpoint != "" {
			options.BaseEndpoint = aws.String(profile.Endpoint)
		}
		options.UsePathStyle = profile.ForcePathStyle
	})
	presignClient := client
	if profile.PresignEndpoint != "" && profile.PresignEndpoint != profile.Endpoint {
		presignClient = s3.NewFromConfig(cfg, func(options *s3.Options) {
			options.BaseEndpoint = aws.String(profile.PresignEndpoint)
			options.UsePathStyle = profile.ForcePathStyle
		})
	}

	return &s3MediaObjectStorage{
		profile: profile,
		client:  client,
		presign: s3.NewPresignClient(presignClient),
	}, nil
}

func (s *s3MediaObjectStorage) Profile() mediaStorageProfile {
	return s.profile
}

func (s *s3MediaObjectStorage) HeadObject(ctx context.Context, objectKey string) (mediaStorageObjectInfo, error) {
	result, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.profile.Bucket),
		Key:    aws.String(objectKey),
	})
	if err != nil {
		return mediaStorageObjectInfo{}, err
	}

	return mediaStorageObjectInfo{
		ByteSize:    aws.ToInt64(result.ContentLength),
		ContentType: aws.ToString(result.ContentType),
		ETag:        aws.ToString(result.ETag),
	}, nil
}

func (s *s3MediaObjectStorage) PresignPutObject(ctx context.Context, objectKey string, contentType string, expires time.Duration) (mediaPresignedRequest, error) {
	expires = s.effectivePresignExpiry(expires)
	input := &s3.PutObjectInput{
		Bucket: aws.String(s.profile.Bucket),
		Key:    aws.String(objectKey),
	}
	if strings.TrimSpace(contentType) != "" {
		input.ContentType = aws.String(strings.TrimSpace(contentType))
	}

	request, err := s.presign.PresignPutObject(ctx, input, s3.WithPresignExpires(expires))
	if err != nil {
		return mediaPresignedRequest{}, err
	}

	return mediaPresignedRequestFromAWS(request.URL, request.Method, request.SignedHeader, expires), nil
}

func (s *s3MediaObjectStorage) PresignGetObject(ctx context.Context, objectKey string, expires time.Duration) (mediaPresignedRequest, error) {
	expires = s.effectivePresignExpiry(expires)
	request, err := s.presign.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.profile.Bucket),
		Key:    aws.String(objectKey),
	}, s3.WithPresignExpires(expires))
	if err != nil {
		return mediaPresignedRequest{}, err
	}

	return mediaPresignedRequestFromAWS(request.URL, request.Method, request.SignedHeader, expires), nil
}

func (s *s3MediaObjectStorage) CreateMultipartUpload(ctx context.Context, objectKey string, contentType string) (string, error) {
	input := &s3.CreateMultipartUploadInput{
		Bucket: aws.String(s.profile.Bucket),
		Key:    aws.String(objectKey),
	}
	if strings.TrimSpace(contentType) != "" {
		input.ContentType = aws.String(strings.TrimSpace(contentType))
	}
	result, err := s.client.CreateMultipartUpload(ctx, input)
	if err != nil {
		return "", err
	}

	return aws.ToString(result.UploadId), nil
}

func (s *s3MediaObjectStorage) PresignUploadPart(ctx context.Context, objectKey string, uploadID string, partNumber int32, expires time.Duration) (mediaPresignedRequest, error) {
	expires = s.effectivePresignExpiry(expires)
	request, err := s.presign.PresignUploadPart(ctx, &s3.UploadPartInput{
		Bucket:     aws.String(s.profile.Bucket),
		Key:        aws.String(objectKey),
		PartNumber: aws.Int32(partNumber),
		UploadId:   aws.String(uploadID),
	}, s3.WithPresignExpires(expires))
	if err != nil {
		return mediaPresignedRequest{}, err
	}

	return mediaPresignedRequestFromAWS(request.URL, request.Method, request.SignedHeader, expires), nil
}

func (s *s3MediaObjectStorage) ListParts(ctx context.Context, objectKey string, uploadID string) ([]uploadedMediaPart, error) {
	var parts []uploadedMediaPart
	var marker *string
	for {
		result, err := s.client.ListParts(ctx, &s3.ListPartsInput{
			Bucket:           aws.String(s.profile.Bucket),
			Key:              aws.String(objectKey),
			UploadId:         aws.String(uploadID),
			PartNumberMarker: marker,
		})
		if err != nil {
			return nil, err
		}
		for _, part := range result.Parts {
			parts = append(parts, uploadedMediaPart{
				PartNumber: aws.ToInt32(part.PartNumber),
				ByteSize:   aws.ToInt64(part.Size),
				ETag:       aws.ToString(part.ETag),
			})
		}
		if result.IsTruncated == nil || !*result.IsTruncated || result.NextPartNumberMarker == nil {
			return parts, nil
		}
		marker = result.NextPartNumberMarker
	}
}

func (s *s3MediaObjectStorage) CompleteMultipartUpload(ctx context.Context, objectKey string, uploadID string, parts []completedMediaUploadPart) (mediaStorageObjectInfo, error) {
	sort.Slice(parts, func(i int, j int) bool { return parts[i].PartNumber < parts[j].PartNumber })
	completedParts := make([]types.CompletedPart, 0, len(parts))
	for _, part := range parts {
		completedParts = append(completedParts, types.CompletedPart{
			ETag:       aws.String(part.ETag),
			PartNumber: aws.Int32(part.PartNumber),
		})
	}

	result, err := s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket:   aws.String(s.profile.Bucket),
		Key:      aws.String(objectKey),
		UploadId: aws.String(uploadID),
		MultipartUpload: &types.CompletedMultipartUpload{
			Parts: completedParts,
		},
	})
	if err != nil {
		return mediaStorageObjectInfo{}, err
	}

	info, err := s.HeadObject(ctx, objectKey)
	if err == nil {
		return info, nil
	}

	return mediaStorageObjectInfo{ETag: aws.ToString(result.ETag)}, nil
}

func (s *s3MediaObjectStorage) AbortMultipartUpload(ctx context.Context, objectKey string, uploadID string) error {
	_, err := s.client.AbortMultipartUpload(ctx, &s3.AbortMultipartUploadInput{
		Bucket:   aws.String(s.profile.Bucket),
		Key:      aws.String(objectKey),
		UploadId: aws.String(uploadID),
	})

	return err
}

func (s *s3MediaObjectStorage) DeleteObject(ctx context.Context, objectKey string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.profile.Bucket),
		Key:    aws.String(objectKey),
	})

	return err
}

func (s *s3MediaObjectStorage) effectivePresignExpiry(expires time.Duration) time.Duration {
	if expires <= 0 {
		return s.profile.PresignTTL
	}

	return expires
}

func mediaPresignedRequestFromAWS(url string, method string, headers http.Header, expires time.Duration) mediaPresignedRequest {
	flatHeaders := make(map[string]string, len(headers))
	for key, values := range headers {
		if len(values) == 0 {
			continue
		}
		flatHeaders[key] = strings.Join(values, ",")
	}

	return mediaPresignedRequest{
		URL:     url,
		Method:  method,
		Headers: flatHeaders,
		Expires: int(expires.Seconds()),
	}
}

func envString(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}

	return value
}

func envBool(name string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}

	return parsed
}

func envInt64(name string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}

	return parsed
}
