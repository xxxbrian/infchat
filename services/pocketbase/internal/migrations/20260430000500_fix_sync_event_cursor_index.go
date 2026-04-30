package migrations

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		syncEvents, err := app.FindCollectionByNameOrId("sync_events")
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}

			return err
		}

		syncEvents.Indexes = removeIndex(syncEvents.Indexes, "idx_sync_events_cursor")
		syncEvents.AddIndex("idx_sync_events_cursor", false, "cursor", "")

		return app.Save(syncEvents)
	}, func(app core.App) error {
		syncEvents, err := app.FindCollectionByNameOrId("sync_events")
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}

			return err
		}

		syncEvents.Indexes = removeIndex(syncEvents.Indexes, "idx_sync_events_cursor")
		syncEvents.AddIndex("idx_sync_events_cursor", true, "cursor", "")

		return app.Save(syncEvents)
	})
}
