package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}

		callRooms, err := app.FindCollectionByNameOrId("call_rooms")
		if err != nil {
			return err
		}

		if kindField, ok := messages.Fields.GetByName("kind").(*core.SelectField); ok {
			kindField.Values = []string{"text", "image", "file", "voice", "call"}
		}

		if messages.Fields.GetByName("call_room") == nil {
			messages.Fields.Add(&core.RelationField{
				Name:         "call_room",
				CollectionId: callRooms.Id,
				MaxSelect:    1,
			})
		}

		messages.AddIndex("idx_messages_call_room", false, "call_room", "")

		return app.Save(messages)
	}, func(app core.App) error {
		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}

		if kindField, ok := messages.Fields.GetByName("kind").(*core.SelectField); ok {
			kindField.Values = []string{"text", "image", "file", "voice"}
		}

		messages.Fields.RemoveByName("call_room")
		messages.Indexes = removeIndex(messages.Indexes, "idx_messages_call_room")

		return app.Save(messages)
	})
}
