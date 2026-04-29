package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		callRooms, err := app.FindCollectionByNameOrId("call_rooms")
		if err != nil {
			return err
		}

		callRooms.AddIndex(
			"idx_call_rooms_one_open_per_conversation",
			true,
			"conversation",
			"status = 'ringing' OR status = 'active'",
		)

		return app.Save(callRooms)
	}, func(app core.App) error {
		callRooms, err := app.FindCollectionByNameOrId("call_rooms")
		if err != nil {
			return err
		}

		callRooms.Indexes = removeIndex(callRooms.Indexes, "idx_call_rooms_one_open_per_conversation")

		return app.Save(callRooms)
	})
}
