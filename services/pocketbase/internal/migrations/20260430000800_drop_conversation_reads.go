package migrations

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("conversation_reads")
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}

			return err
		}

		return app.Delete(collection)
	}, func(app core.App) error {
		return nil
	})
}
