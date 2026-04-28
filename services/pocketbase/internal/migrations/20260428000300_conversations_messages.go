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

		conversations := core.NewBaseCollection("conversations")
		conversations.ListRule = pointer("members.id ?= @request.auth.id")
		conversations.ViewRule = pointer("members.id ?= @request.auth.id")
		conversations.CreateRule = pointer("@request.auth.id != ''")
		conversations.UpdateRule = nil
		conversations.DeleteRule = nil
		conversations.Fields.Add(
			&core.SelectField{Name: "kind", Required: true, Values: []string{"private", "group"}},
			&core.TextField{Name: "pair_key", Max: 64},
			&core.RelationField{Name: "created_by", CollectionId: users.Id, MaxSelect: 1},
			&core.RelationField{Name: "members", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 50, Required: true},
			&core.TextField{Name: "title", Max: 80},
			&core.TextField{Name: "last_message_text", Max: 500},
			&core.DateField{Name: "last_message_at"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		conversations.AddIndex("idx_conversations_private_pair", true, "pair_key", "kind = 'private' AND pair_key != ''")
		conversations.AddIndex("idx_conversations_last_message_at", false, "last_message_at", "")

		if err := app.Save(conversations); err != nil {
			return err
		}

		messages := core.NewBaseCollection("messages")
		messages.ListRule = pointer("conversation.members.id ?= @request.auth.id")
		messages.ViewRule = pointer("conversation.members.id ?= @request.auth.id")
		messages.CreateRule = pointer("@request.auth.id != ''")
		messages.UpdateRule = nil
		messages.DeleteRule = nil
		messages.Fields.Add(
			&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "sender", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.SelectField{Name: "kind", Required: true, Values: []string{"text", "image", "voice"}},
			&core.TextField{Name: "body", Required: true, Max: 4000},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		messages.AddIndex("idx_messages_conversation_created", false, "conversation, created", "")

		return app.Save(messages)
	}, func(app core.App) error {
		messages, err := app.FindCollectionByNameOrId("messages")
		if err == nil {
			if err := app.Delete(messages); err != nil {
				return err
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		conversations, err := app.FindCollectionByNameOrId("conversations")
		if err == nil {
			return app.Delete(conversations)
		}

		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}

		return err
	})
}
