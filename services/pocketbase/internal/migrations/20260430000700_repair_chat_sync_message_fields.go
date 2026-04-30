package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		conversations, err := app.FindCollectionByNameOrId("conversations")
		if err != nil {
			return err
		}
		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}

		if messages.Fields.GetByName("client_message_id") == nil {
			messages.Fields.Add(&core.TextField{Name: "client_message_id", Max: 160})
		}
		if messages.Fields.GetByName("sender_device_id") == nil {
			messages.Fields.Add(&core.TextField{Name: "sender_device_id", Max: 160})
		}
		if messages.Fields.GetByName("message_seq") == nil {
			messages.Fields.Add(&core.NumberField{Name: "message_seq", OnlyInt: true})
		}
		if messages.Fields.GetByName("deleted_at") == nil {
			messages.Fields.Add(&core.DateField{Name: "deleted_at"})
		}
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}
		if messages.Fields.GetByName("deleted_by") == nil {
			messages.Fields.Add(&core.RelationField{Name: "deleted_by", CollectionId: users.Id, CascadeDelete: false, MaxSelect: 1})
		}
		if messages.Fields.GetByName("edited_at") == nil {
			messages.Fields.Add(&core.DateField{Name: "edited_at"})
		}
		if messages.Fields.GetByName("edit_version") == nil {
			messages.Fields.Add(&core.NumberField{Name: "edit_version", OnlyInt: true})
		}
		messages.Indexes = removeIndex(messages.Indexes, "idx_messages_conversation_seq")
		messages.Indexes = removeIndex(messages.Indexes, "idx_messages_client_message")
		messages.AddIndex("idx_messages_conversation_seq", true, "conversation, message_seq", "message_seq > 0")
		messages.AddIndex("idx_messages_client_message", true, "sender, sender_device_id, client_message_id", "client_message_id != '' AND sender_device_id != ''")
		if err := app.Save(messages); err != nil {
			return err
		}

		if conversations.Fields.GetByName("next_message_seq") == nil {
			conversations.Fields.Add(&core.NumberField{Name: "next_message_seq", OnlyInt: true})
		}
		if conversations.Fields.GetByName("last_message_id") == nil {
			conversations.Fields.Add(&core.TextField{Name: "last_message_id", Max: 32})
		}
		if conversations.Fields.GetByName("last_message_seq") == nil {
			conversations.Fields.Add(&core.NumberField{Name: "last_message_seq", OnlyInt: true})
		}
		if conversations.Fields.GetByName("last_change_cursor") == nil {
			conversations.Fields.Add(&core.NumberField{Name: "last_change_cursor", OnlyInt: true})
		}
		conversations.Indexes = removeIndex(conversations.Indexes, "idx_conversations_last_message_seq")
		conversations.AddIndex("idx_conversations_last_message_seq", false, "last_message_seq", "")
		if err := app.Save(conversations); err != nil {
			return err
		}

		return backfillChatSyncProtocol(app)
	}, func(app core.App) error {
		return nil
	})
}
