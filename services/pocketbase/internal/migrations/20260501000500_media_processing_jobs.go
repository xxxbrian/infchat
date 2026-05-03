package migrations

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		attachments, err := app.FindCollectionByNameOrId("message_attachments")
		if err != nil {
			return err
		}
		if statusField, ok := attachments.Fields.GetByName("processing_status").(*core.SelectField); ok {
			statusField.Values = []string{"pending", "processing", "ready", "failed"}
		}
		attachments.Indexes = removeIndex(attachments.Indexes, "idx_message_attachments_processing")
		attachments.AddIndex("idx_message_attachments_processing", false, "processing_status, updated", "")
		if err := app.Save(attachments); err != nil {
			return err
		}

		return ensureMediaProcessingJobsCollection(app, attachments)
	}, func(app core.App) error {
		if err := dropCollectionIfExists(app, "media_processing_jobs"); err != nil {
			return err
		}

		attachments, err := app.FindCollectionByNameOrId("message_attachments")
		if err != nil {
			return err
		}
		if statusField, ok := attachments.Fields.GetByName("processing_status").(*core.SelectField); ok {
			statusField.Values = []string{"pending", "ready", "failed"}
		}
		attachments.Indexes = removeIndex(attachments.Indexes, "idx_message_attachments_processing")

		return app.Save(attachments)
	})
}

func ensureMediaProcessingJobsCollection(app core.App, attachments *core.Collection) error {
	collection, err := app.FindCollectionByNameOrId("media_processing_jobs")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		collection = core.NewBaseCollection("media_processing_jobs")
	}

	collection.ListRule = nil
	collection.ViewRule = nil
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	ensureRelationField(collection, "attachment", attachments.Id, true, true)
	ensureSelectField(collection, "kind", []string{"image", "video"}, true)
	ensureSelectField(collection, "state", []string{"queued", "processing", "succeeded", "failed", "dead"}, true)
	ensureNumberField(collection, "attempt_count", false)
	ensureDateField(collection, "next_attempt_at")
	ensureDateField(collection, "leased_until")
	ensureTextField(collection, "lease_owner", 160, false)
	ensureTextField(collection, "last_error", 2000, false)
	ensureAutodateFields(collection)
	collection.Indexes = removeIndex(collection.Indexes, "idx_media_processing_jobs_attachment")
	collection.Indexes = removeIndex(collection.Indexes, "idx_media_processing_jobs_state_next")
	collection.Indexes = removeIndex(collection.Indexes, "idx_media_processing_jobs_lease")
	collection.AddIndex("idx_media_processing_jobs_attachment", true, "attachment", "")
	collection.AddIndex("idx_media_processing_jobs_state_next", false, "state, next_attempt_at, updated", "")
	collection.AddIndex("idx_media_processing_jobs_lease", false, "state, leased_until", "state='processing'")

	return app.Save(collection)
}
