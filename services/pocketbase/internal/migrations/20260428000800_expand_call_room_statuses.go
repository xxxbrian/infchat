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

		if statusField, ok := callRooms.Fields.GetByName("status").(*core.SelectField); ok {
			statusField.Values = []string{"ringing", "active", "ended", "missed", "declined", "canceled"}
		}

		return app.Save(callRooms)
	}, func(app core.App) error {
		callRooms, err := app.FindCollectionByNameOrId("call_rooms")
		if err != nil {
			return err
		}

		if statusField, ok := callRooms.Fields.GetByName("status").(*core.SelectField); ok {
			statusField.Values = []string{"ringing", "active", "ended"}
		}

		return app.Save(callRooms)
	})
}
