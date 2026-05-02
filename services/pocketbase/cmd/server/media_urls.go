package main

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

type signMediaURLsRequest struct {
	Items []signMediaURLRequestItem `json:"items" form:"items"`
}

type signMediaURLRequestItem struct {
	AttachmentId string `json:"attachmentId" form:"attachmentId"`
	Variant      string `json:"variant" form:"variant"`
	VariantId    string `json:"variantId" form:"variantId"`
}

type signedMediaURLResponse struct {
	AttachmentID string                `json:"attachmentId"`
	ExpiresAt    string                `json:"expiresAt"`
	ObjectKey    string                `json:"objectKey"`
	Presigned    mediaPresignedRequest `json:"presigned"`
	Variant      string                `json:"variant"`
	VariantID    string                `json:"variantId"`
}

func bindMediaURLRoutes(group *router.RouterGroup[*core.RequestEvent]) {
	group.POST("/media/urls", func(e *core.RequestEvent) error {
		data := signMediaURLsRequest{}
		if err := e.BindBody(&data); err != nil {
			return e.BadRequestError("Failed to read media URL data.", err)
		}

		result, err := signMediaURLsCommand(e.Request.Context(), e.App, e.Auth.Id, data.Items)
		if err != nil {
			return err
		}

		return e.JSON(http.StatusOK, map[string]any{"items": result})
	})
}

func signMediaURLsCommand(ctx context.Context, app core.App, userId string, items []signMediaURLRequestItem) ([]signedMediaURLResponse, error) {
	if len(items) == 0 {
		return nil, router.NewBadRequestError("Media URL items are required.", nil)
	}
	if len(items) > 100 {
		return nil, router.NewBadRequestError("Too many media URL items requested.", nil)
	}
	storage, err := newMediaObjectStorageFromEnv(ctx)
	if err != nil {
		return nil, mediaStorageAPIError(err)
	}

	result := make([]signedMediaURLResponse, 0, len(items))
	for _, item := range items {
		variant, attachment, message, err := findAuthorizedAttachmentVariant(app, userId, item)
		if err != nil {
			return nil, err
		}
		membership, err := findActiveMembershipByConversation(app, message.GetString("conversation"), userId)
		if err != nil {
			return nil, router.NewForbiddenError("You cannot access this media item.", err)
		}
		if message.GetInt("message_seq") < membership.GetInt("history_start_message_seq") {
			return nil, router.NewForbiddenError("You cannot access this media item.", nil)
		}

		ttl := mediaDownloadURLTTL(variant.GetString("variant"), attachment.GetString("kind"))
		presigned, err := storage.PresignGetObject(ctx, variant.GetString("object_key"), ttl)
		if err != nil {
			return nil, mediaStorageAPIError(err)
		}
		result = append(result, signedMediaURLResponse{
			AttachmentID: attachment.Id,
			ExpiresAt:    time.Now().Add(ttl).UTC().Format(time.RFC3339),
			ObjectKey:    variant.GetString("object_key"),
			Presigned:    presigned,
			Variant:      variant.GetString("variant"),
			VariantID:    variant.Id,
		})
	}

	return result, nil
}

func findAuthorizedAttachmentVariant(app core.App, userId string, item signMediaURLRequestItem) (*core.Record, *core.Record, *core.Record, error) {
	variantId := strings.TrimSpace(item.VariantId)
	attachmentId := strings.TrimSpace(item.AttachmentId)
	variantName := strings.TrimSpace(item.Variant)
	var variant *core.Record
	var err error
	if variantId != "" {
		variant, err = app.FindRecordById("attachment_variants", variantId)
	} else {
		if attachmentId == "" || variantName == "" {
			return nil, nil, nil, router.NewBadRequestError("variantId or attachmentId plus variant is required.", nil)
		}
		variant, err = app.FindFirstRecordByFilter(
			"attachment_variants",
			"attachment={:attachment} && variant={:variant}",
			dbx.Params{"attachment": attachmentId, "variant": variantName},
		)
	}
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil, nil, router.NewBadRequestError("Attachment variant was not found.", nil)
		}
		return nil, nil, nil, err
	}

	attachment, err := app.FindRecordById("message_attachments", variant.GetString("attachment"))
	if err != nil {
		return nil, nil, nil, err
	}
	message, err := app.FindRecordById("messages", attachment.GetString("message"))
	if err != nil {
		return nil, nil, nil, err
	}
	if message.GetString("deleted_at") != "" {
		return nil, nil, nil, router.NewBadRequestError("Message was deleted.", nil)
	}

	return variant, attachment, message, nil
}

func mediaDownloadURLTTL(variant string, attachmentKind string) time.Duration {
	switch variant {
	case "thumbnail", "poster":
		return 30 * time.Minute
	case "preview":
		return 15 * time.Minute
	case "original":
		if attachmentKind == "file" || attachmentKind == "voice" {
			return 10 * time.Minute
		}
		return 15 * time.Minute
	default:
		return 10 * time.Minute
	}
}
