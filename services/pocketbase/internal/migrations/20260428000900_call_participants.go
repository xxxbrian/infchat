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

		callRooms, err := app.FindCollectionByNameOrId("call_rooms")
		if err != nil {
			return err
		}

		callParticipants := core.NewBaseCollection("call_participants")
		callParticipants.ListRule = pointer("call_room.conversation.members.id ?= @request.auth.id")
		callParticipants.ViewRule = pointer("call_room.conversation.members.id ?= @request.auth.id")
		callParticipants.CreateRule = nil
		callParticipants.UpdateRule = nil
		callParticipants.DeleteRule = nil
		callParticipants.Fields.Add(
			&core.RelationField{Name: "call_room", CollectionId: callRooms.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.TextField{Name: "device_id", Required: true, Max: 160},
			&core.SelectField{Name: "status", Required: true, Values: []string{"active", "left"}},
			&core.DateField{Name: "joined_at"},
			&core.DateField{Name: "left_at"},
			&core.DateField{Name: "last_seen_at"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		callParticipants.AddIndex("idx_call_participants_device", true, "call_room, user, device_id", "")
		callParticipants.AddIndex("idx_call_participants_call_status", false, "call_room, status, last_seen_at", "")

		return app.Save(callParticipants)
	}, func(app core.App) error {
		callParticipants, err := app.FindCollectionByNameOrId("call_participants")
		if err == nil {
			return app.Delete(callParticipants)
		}

		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}

		return err
	})
}
