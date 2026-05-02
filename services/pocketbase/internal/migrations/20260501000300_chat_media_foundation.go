package migrations

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		conversations, err := app.FindCollectionByNameOrId("conversations")
		if err != nil {
			return err
		}
		memberships, err := app.FindCollectionByNameOrId("conversation_memberships")
		if err != nil {
			return err
		}
		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}

		if _, err := app.DB().NewQuery("UPDATE messages SET kind='media' WHERE kind='image'").Execute(); err != nil {
			return err
		}

		if kindField, ok := messages.Fields.GetByName("kind").(*core.SelectField); ok {
			kindField.Values = []string{"text", "media", "file", "voice", "call"}
		}
		if attachmentsField, ok := messages.Fields.GetByName("attachments").(*core.FileField); ok {
			attachmentsField.Hidden = true
			attachmentsField.Help = "Legacy PocketBase-hosted attachments. New chat media uses message_attachments and attachment_variants."
		}
		if err := app.Save(messages); err != nil {
			return err
		}

		storageProfiles, err := ensureStorageProfilesCollection(app)
		if err != nil {
			return err
		}
		attachments, err := ensureMessageAttachmentsCollection(app, users, conversations, memberships, messages)
		if err != nil {
			return err
		}
		if err := ensureAttachmentVariantsCollection(app, conversations, messages, attachments, storageProfiles); err != nil {
			return err
		}
		uploadSessions, err := ensureMediaUploadSessionsCollection(app, users, conversations, storageProfiles)
		if err != nil {
			return err
		}

		return ensureMediaUploadPartsCollection(app, uploadSessions)
	}, func(app core.App) error {
		for _, name := range []string{
			"media_upload_parts",
			"media_upload_sessions",
			"attachment_variants",
			"message_attachments",
			"storage_profiles",
		} {
			if err := dropCollectionIfExists(app, name); err != nil {
				return err
			}
		}

		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}
		if _, err := app.DB().NewQuery("UPDATE messages SET kind='image' WHERE kind='media'").Execute(); err != nil {
			return err
		}
		if kindField, ok := messages.Fields.GetByName("kind").(*core.SelectField); ok {
			kindField.Values = []string{"text", "image", "file", "voice", "call"}
		}
		if attachmentsField, ok := messages.Fields.GetByName("attachments").(*core.FileField); ok {
			attachmentsField.Hidden = false
			attachmentsField.Help = ""
		}

		return app.Save(messages)
	})
}

func ensureStorageProfilesCollection(app core.App) (*core.Collection, error) {
	collection, err := app.FindCollectionByNameOrId("storage_profiles")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		collection = core.NewBaseCollection("storage_profiles")
	}

	collection.ListRule = nil
	collection.ViewRule = nil
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	ensureTextField(collection, "name", 80, false)
	ensureSelectField(collection, "driver", []string{"s3"}, true)
	ensureSelectField(collection, "status", []string{"active", "inactive"}, true)
	ensureTextField(collection, "endpoint", 500, false)
	ensureTextField(collection, "region", 80, false)
	ensureTextField(collection, "bucket", 255, false)
	ensureTextField(collection, "public_base_url", 500, false)
	ensureBoolField(collection, "force_path_style")
	ensureNumberField(collection, "presign_ttl_seconds", false)
	ensureNumberField(collection, "multipart_threshold_bytes", false)
	ensureNumberField(collection, "multipart_part_size_bytes", false)
	ensureNumberField(collection, "max_object_size_bytes", false)
	ensureJSONField(collection, "capabilities_json", 64*1024, false)
	ensureAutodateFields(collection)
	collection.Indexes = removeIndex(collection.Indexes, "idx_storage_profiles_active")
	collection.AddIndex("idx_storage_profiles_active", false, "status, driver", "")

	return collection, app.Save(collection)
}

func ensureMessageAttachmentsCollection(app core.App, users *core.Collection, conversations *core.Collection, memberships *core.Collection, messages *core.Collection) (*core.Collection, error) {
	collection, err := app.FindCollectionByNameOrId("message_attachments")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		collection = core.NewBaseCollection("message_attachments")
	}

	membershipRule := "@request.auth.id != '' && @collection." + memberships.Name + ".conversation ?= conversation && @collection." + memberships.Name + ".user ?= @request.auth.id && @collection." + memberships.Name + ".status ?= 'active' && message.message_seq >= @collection." + memberships.Name + ".history_start_message_seq"
	collection.ListRule = pointer(membershipRule)
	collection.ViewRule = pointer(membershipRule)
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	ensureRelationField(collection, "message", messages.Id, true, true)
	ensureRelationField(collection, "conversation", conversations.Id, true, true)
	ensureRelationField(collection, "sender", users.Id, true, true)
	ensureNumberField(collection, "ordinal", false)
	ensureSelectField(collection, "kind", []string{"image", "video", "file", "voice"}, true)
	ensureTextField(collection, "original_name", 512, false)
	ensureTextField(collection, "mime_type", 255, false)
	ensureNumberField(collection, "byte_size", false)
	ensureNumberField(collection, "width", false)
	ensureNumberField(collection, "height", false)
	ensureNumberField(collection, "duration_ms", false)
	ensureTextField(collection, "sha256", 128, false)
	ensureTextField(collection, "blurhash", 200, false)
	ensureJSONField(collection, "waveform_json", 64*1024, false)
	ensureSelectField(collection, "processing_status", []string{"pending", "ready", "failed"}, true)
	ensureTextField(collection, "processing_error", 1000, false)
	ensureAutodateFields(collection)
	collection.Indexes = removeIndex(collection.Indexes, "idx_message_attachments_message_ordinal")
	collection.Indexes = removeIndex(collection.Indexes, "idx_message_attachments_conversation_message")
	collection.Indexes = removeIndex(collection.Indexes, "idx_message_attachments_sender_created")
	collection.Indexes = removeIndex(collection.Indexes, "idx_message_attachments_sha256")
	collection.AddIndex("idx_message_attachments_message_ordinal", true, "message, ordinal", "")
	collection.AddIndex("idx_message_attachments_conversation_message", false, "conversation, message, ordinal", "")
	collection.AddIndex("idx_message_attachments_sender_created", false, "sender, created", "")
	collection.AddIndex("idx_message_attachments_sha256", false, "sha256", "sha256 != ''")

	return collection, app.Save(collection)
}

func ensureAttachmentVariantsCollection(app core.App, conversations *core.Collection, messages *core.Collection, attachments *core.Collection, storageProfiles *core.Collection) error {
	collection, err := app.FindCollectionByNameOrId("attachment_variants")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		collection = core.NewBaseCollection("attachment_variants")
	}

	collection.ListRule = pointer("@request.auth.id != '' && @collection.conversation_memberships.conversation ?= conversation && @collection.conversation_memberships.user ?= @request.auth.id && @collection.conversation_memberships.status ?= 'active' && message.message_seq >= @collection.conversation_memberships.history_start_message_seq")
	collection.ViewRule = pointer("@request.auth.id != '' && @collection.conversation_memberships.conversation ?= conversation && @collection.conversation_memberships.user ?= @request.auth.id && @collection.conversation_memberships.status ?= 'active' && message.message_seq >= @collection.conversation_memberships.history_start_message_seq")
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	ensureRelationField(collection, "attachment", attachments.Id, true, true)
	ensureRelationField(collection, "message", messages.Id, false, true)
	ensureRelationField(collection, "conversation", conversations.Id, false, true)
	ensureRelationField(collection, "storage_profile", storageProfiles.Id, false, true)
	ensureSelectField(collection, "variant", []string{"thumbnail", "preview", "original", "poster"}, true)
	ensureTextField(collection, "object_key", 1024, true)
	ensureTextField(collection, "mime_type", 255, false)
	ensureNumberField(collection, "byte_size", false)
	ensureNumberField(collection, "width", false)
	ensureNumberField(collection, "height", false)
	ensureNumberField(collection, "duration_ms", false)
	ensureTextField(collection, "sha256", 128, false)
	ensureTextField(collection, "etag", 255, false)
	ensureAutodateFields(collection)
	collection.Indexes = removeIndex(collection.Indexes, "idx_attachment_variants_attachment_variant")
	collection.Indexes = removeIndex(collection.Indexes, "idx_attachment_variants_object_key")
	collection.Indexes = removeIndex(collection.Indexes, "idx_attachment_variants_conversation_variant")
	collection.AddIndex("idx_attachment_variants_attachment_variant", true, "attachment, variant", "")
	collection.AddIndex("idx_attachment_variants_object_key", true, "object_key", "object_key != ''")
	collection.AddIndex("idx_attachment_variants_conversation_variant", false, "conversation, variant", "")

	return app.Save(collection)
}

func ensureMediaUploadSessionsCollection(app core.App, users *core.Collection, conversations *core.Collection, storageProfiles *core.Collection) (*core.Collection, error) {
	collection, err := app.FindCollectionByNameOrId("media_upload_sessions")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		collection = core.NewBaseCollection("media_upload_sessions")
	}

	collection.ListRule = pointer("@request.auth.id != '' && user = @request.auth.id")
	collection.ViewRule = pointer("@request.auth.id != '' && user = @request.auth.id")
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	ensureRelationField(collection, "conversation", conversations.Id, true, true)
	ensureRelationField(collection, "user", users.Id, true, true)
	ensureTextField(collection, "client_message_id", 160, true)
	ensureTextField(collection, "attachment_id", 32, true)
	ensureSelectField(collection, "attachment_kind", []string{"image", "video", "file", "voice"}, true)
	ensureSelectField(collection, "variant", []string{"thumbnail", "preview", "original", "poster"}, true)
	ensureRelationField(collection, "storage_profile", storageProfiles.Id, false, true)
	ensureTextField(collection, "object_key", 1024, true)
	ensureTextField(collection, "upload_id", 1024, false)
	ensureSelectField(collection, "upload_mode", []string{"single", "multipart"}, true)
	ensureTextField(collection, "original_name", 512, false)
	ensureTextField(collection, "mime_type", 255, false)
	ensureNumberField(collection, "byte_size", false)
	ensureNumberField(collection, "width", false)
	ensureNumberField(collection, "height", false)
	ensureNumberField(collection, "duration_ms", false)
	ensureTextField(collection, "sha256", 128, false)
	ensureTextField(collection, "blurhash", 200, false)
	ensureNumberField(collection, "part_size", false)
	ensureNumberField(collection, "part_count", false)
	ensureSelectField(collection, "state", []string{"pending", "uploading", "uploaded", "completing", "completed", "aborted", "failed", "expired"}, true)
	ensureDateField(collection, "expires_at")
	ensureDateField(collection, "completed_at")
	ensureTextField(collection, "last_error", 1000, false)
	ensureAutodateFields(collection)
	collection.Indexes = removeIndex(collection.Indexes, "idx_media_upload_sessions_user_state")
	collection.Indexes = removeIndex(collection.Indexes, "idx_media_upload_sessions_conversation_client")
	collection.Indexes = removeIndex(collection.Indexes, "idx_media_upload_sessions_attachment_variant")
	collection.Indexes = removeIndex(collection.Indexes, "idx_media_upload_sessions_object_key")
	collection.AddIndex("idx_media_upload_sessions_user_state", false, "user, state, updated", "")
	collection.AddIndex("idx_media_upload_sessions_conversation_client", false, "conversation, client_message_id", "")
	collection.AddIndex("idx_media_upload_sessions_attachment_variant", true, "attachment_id, variant", "")
	collection.AddIndex("idx_media_upload_sessions_object_key", true, "object_key", "object_key != ''")

	return collection, app.Save(collection)
}

func ensureMediaUploadPartsCollection(app core.App, uploadSessions *core.Collection) error {
	collection, err := app.FindCollectionByNameOrId("media_upload_parts")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		collection = core.NewBaseCollection("media_upload_parts")
	}

	collection.ListRule = pointer("@request.auth.id != '' && upload_session.user = @request.auth.id")
	collection.ViewRule = pointer("@request.auth.id != '' && upload_session.user = @request.auth.id")
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	ensureRelationField(collection, "upload_session", uploadSessions.Id, true, true)
	ensureNumberField(collection, "part_number", false)
	ensureNumberField(collection, "offset_bytes", false)
	ensureNumberField(collection, "byte_size", false)
	ensureTextField(collection, "etag", 255, false)
	ensureTextField(collection, "checksum_sha256", 128, false)
	ensureSelectField(collection, "state", []string{"pending", "signed", "uploaded", "failed"}, true)
	ensureDateField(collection, "signed_url_expires_at")
	ensureNumberField(collection, "attempt_count", false)
	ensureTextField(collection, "last_error", 1000, false)
	ensureAutodateFields(collection)
	collection.Indexes = removeIndex(collection.Indexes, "idx_media_upload_parts_session_part")
	collection.Indexes = removeIndex(collection.Indexes, "idx_media_upload_parts_state")
	collection.AddIndex("idx_media_upload_parts_session_part", true, "upload_session, part_number", "")
	collection.AddIndex("idx_media_upload_parts_state", false, "state, updated", "")

	return app.Save(collection)
}

func ensureTextField(collection *core.Collection, name string, max int, required bool) {
	field, ok := collection.Fields.GetByName(name).(*core.TextField)
	if !ok || field == nil {
		field = &core.TextField{Name: name}
		collection.Fields.Add(field)
	}
	field.Max = max
	field.Required = required
}

func ensureSelectField(collection *core.Collection, name string, values []string, required bool) {
	field, ok := collection.Fields.GetByName(name).(*core.SelectField)
	if !ok || field == nil {
		field = &core.SelectField{Name: name}
		collection.Fields.Add(field)
	}
	field.Values = values
	field.Required = required
}

func ensureRelationField(collection *core.Collection, name string, collectionId string, cascadeDelete bool, required bool) {
	field, ok := collection.Fields.GetByName(name).(*core.RelationField)
	if !ok || field == nil {
		field = &core.RelationField{Name: name}
		collection.Fields.Add(field)
	}
	field.CollectionId = collectionId
	field.CascadeDelete = cascadeDelete
	field.MaxSelect = 1
	field.Required = required
}

func ensureNumberField(collection *core.Collection, name string, required bool) {
	field, ok := collection.Fields.GetByName(name).(*core.NumberField)
	if !ok || field == nil {
		field = &core.NumberField{Name: name}
		collection.Fields.Add(field)
	}
	field.OnlyInt = true
	field.Required = required
}

func ensureBoolField(collection *core.Collection, name string) {
	if collection.Fields.GetByName(name) == nil {
		collection.Fields.Add(&core.BoolField{Name: name})
	}
}

func ensureJSONField(collection *core.Collection, name string, maxSize int64, required bool) {
	field, ok := collection.Fields.GetByName(name).(*core.JSONField)
	if !ok || field == nil {
		field = &core.JSONField{Name: name}
		collection.Fields.Add(field)
	}
	field.MaxSize = maxSize
	field.Required = required
}

func ensureDateField(collection *core.Collection, name string) {
	if collection.Fields.GetByName(name) == nil {
		collection.Fields.Add(&core.DateField{Name: name})
	}
}

func ensureAutodateFields(collection *core.Collection) {
	if collection.Fields.GetByName("created") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true})
	}
	if collection.Fields.GetByName("updated") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true})
	}
}
