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

		callRooms := core.NewBaseCollection("call_rooms")
		callRooms.ListRule = pointer("conversation.members.id ?= @request.auth.id")
		callRooms.ViewRule = pointer("conversation.members.id ?= @request.auth.id")
		callRooms.CreateRule = nil
		callRooms.UpdateRule = nil
		callRooms.DeleteRule = nil
		callRooms.Fields.Add(
			&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "created_by", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.SelectField{Name: "kind", Required: true, Values: []string{"voice", "video"}},
			&core.TextField{Name: "room_name", Required: true, Max: 160},
			&core.SelectField{Name: "status", Required: true, Values: []string{"ringing", "active", "ended"}},
			&core.DateField{Name: "ended_at"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		callRooms.AddIndex("idx_call_rooms_conversation_status", false, "conversation, status, created", "")
		callRooms.AddIndex("idx_call_rooms_room_name", true, "room_name", "")

		return app.Save(callRooms)
	}, func(app core.App) error {
		callRooms, err := app.FindCollectionByNameOrId("call_rooms")
		if err == nil {
			return app.Delete(callRooms)
		}

		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}

		return err
	})
}
