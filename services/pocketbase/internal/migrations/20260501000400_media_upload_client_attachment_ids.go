package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		sessions, err := app.FindCollectionByNameOrId("media_upload_sessions")
		if err != nil {
			return err
		}

		ensureTextField(sessions, "client_attachment_id", 160, false)
		ensureNumberField(sessions, "ordinal", false)
		sessions.Indexes = removeIndex(sessions.Indexes, "idx_media_upload_sessions_client_attachment_variant")
		sessions.Indexes = removeIndex(sessions.Indexes, "idx_media_upload_sessions_client_ordinal")
		sessions.AddIndex("idx_media_upload_sessions_client_attachment_variant", true, "user, conversation, client_message_id, client_attachment_id, variant", "client_attachment_id != '' AND state != 'aborted'")
		sessions.AddIndex("idx_media_upload_sessions_client_ordinal", false, "user, conversation, client_message_id, ordinal", "")

		return app.Save(sessions)
	}, func(app core.App) error {
		sessions, err := app.FindCollectionByNameOrId("media_upload_sessions")
		if err != nil {
			return err
		}

		sessions.Indexes = removeIndex(sessions.Indexes, "idx_media_upload_sessions_client_attachment_variant")
		sessions.Indexes = removeIndex(sessions.Indexes, "idx_media_upload_sessions_client_ordinal")
		sessions.Fields.RemoveByName("client_attachment_id")
		sessions.Fields.RemoveByName("ordinal")

		return app.Save(sessions)
	})
}
