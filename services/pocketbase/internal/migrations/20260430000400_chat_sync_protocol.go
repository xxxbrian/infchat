package migrations

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/dbx"
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

		if err := ensureConversationUserStatesCollection(app, users, conversations); err != nil {
			return err
		}
		if err := ensureSyncCursorsCollection(app); err != nil {
			return err
		}
		if err := ensureSyncEventsCollection(app, users, conversations); err != nil {
			return err
		}
		if err := ensureIdempotencyKeysCollection(app, users, conversations, messages); err != nil {
			return err
		}
		if err := ensurePushOutboxCollection(app, users, conversations); err != nil {
			return err
		}

		return backfillChatSyncProtocol(app)
	}, func(app core.App) error {
		for _, name := range []string{"push_outbox", "idempotency_keys", "sync_events", "sync_cursors", "conversation_user_states"} {
			collection, err := app.FindCollectionByNameOrId(name)
			if err == nil {
				if err := app.Delete(collection); err != nil {
					return err
				}
			} else if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
		}

		conversations, err := app.FindCollectionByNameOrId("conversations")
		if err != nil {
			return err
		}
		conversations.Fields.RemoveByName("next_message_seq")
		conversations.Fields.RemoveByName("last_message_id")
		conversations.Fields.RemoveByName("last_message_seq")
		conversations.Fields.RemoveByName("last_change_cursor")
		conversations.Indexes = removeIndex(conversations.Indexes, "idx_conversations_last_message_seq")
		if err := app.Save(conversations); err != nil {
			return err
		}

		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}
		messages.Fields.RemoveByName("client_message_id")
		messages.Fields.RemoveByName("sender_device_id")
		messages.Fields.RemoveByName("message_seq")
		messages.Fields.RemoveByName("deleted_at")
		messages.Fields.RemoveByName("edited_at")
		messages.Fields.RemoveByName("edit_version")
		messages.Indexes = removeIndex(messages.Indexes, "idx_messages_conversation_seq")
		messages.Indexes = removeIndex(messages.Indexes, "idx_messages_client_message")

		return app.Save(messages)
	})
}

func ensureConversationUserStatesCollection(app core.App, users *core.Collection, conversations *core.Collection) error {
	collection, err := app.FindCollectionByNameOrId("conversation_user_states")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		collection = core.NewBaseCollection("conversation_user_states")
	}

	collection.ListRule = pointer("user = @request.auth.id")
	collection.ViewRule = pointer("user = @request.auth.id")
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	if collection.Fields.GetByName("conversation") == nil {
		collection.Fields.Add(&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1, Required: true})
	}
	if collection.Fields.GetByName("user") == nil {
		collection.Fields.Add(&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true})
	}
	if collection.Fields.GetByName("last_read_seq") == nil {
		collection.Fields.Add(&core.NumberField{Name: "last_read_seq", OnlyInt: true})
	}
	if collection.Fields.GetByName("unread_count") == nil {
		collection.Fields.Add(&core.NumberField{Name: "unread_count", OnlyInt: true})
	}
	if collection.Fields.GetByName("last_delivered_cursor") == nil {
		collection.Fields.Add(&core.NumberField{Name: "last_delivered_cursor", OnlyInt: true})
	}
	if collection.Fields.GetByName("created") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true})
	}
	if collection.Fields.GetByName("updated") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true})
	}
	collection.Indexes = removeIndex(collection.Indexes, "idx_conversation_user_states_unique")
	collection.Indexes = removeIndex(collection.Indexes, "idx_conversation_user_states_user")
	collection.AddIndex("idx_conversation_user_states_unique", true, "conversation, user", "")
	collection.AddIndex("idx_conversation_user_states_user", false, "user, last_delivered_cursor", "")

	return app.Save(collection)
}

func ensureSyncCursorsCollection(app core.App) error {
	collection, err := app.FindCollectionByNameOrId("sync_cursors")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		collection = core.NewBaseCollection("sync_cursors")
	}

	collection.ListRule = nil
	collection.ViewRule = nil
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	if collection.Fields.GetByName("scope") == nil {
		collection.Fields.Add(&core.TextField{Name: "scope", Required: true, Max: 80})
	}
	if collection.Fields.GetByName("next_cursor") == nil {
		collection.Fields.Add(&core.NumberField{Name: "next_cursor", Required: true, OnlyInt: true})
	}
	if collection.Fields.GetByName("created") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true})
	}
	if collection.Fields.GetByName("updated") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true})
	}
	collection.Indexes = removeIndex(collection.Indexes, "idx_sync_cursors_scope")
	collection.AddIndex("idx_sync_cursors_scope", true, "scope", "")

	return app.Save(collection)
}

func ensureSyncEventsCollection(app core.App, users *core.Collection, conversations *core.Collection) error {
	collection, err := app.FindCollectionByNameOrId("sync_events")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		collection = core.NewBaseCollection("sync_events")
	}

	collection.ListRule = pointer("user = @request.auth.id")
	collection.ViewRule = pointer("user = @request.auth.id")
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	if collection.Fields.GetByName("user") == nil {
		collection.Fields.Add(&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true})
	}
	if collection.Fields.GetByName("conversation") == nil {
		collection.Fields.Add(&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1})
	}
	if collection.Fields.GetByName("type") == nil {
		collection.Fields.Add(&core.SelectField{Name: "type", Required: true, Values: []string{"message.created", "message.updated", "message.deleted", "conversation.updated", "read.updated"}})
	}
	if collection.Fields.GetByName("entity_id") == nil {
		collection.Fields.Add(&core.TextField{Name: "entity_id", Max: 80})
	}
	if collection.Fields.GetByName("cursor") == nil {
		collection.Fields.Add(&core.NumberField{Name: "cursor", Required: true, OnlyInt: true})
	}
	if collection.Fields.GetByName("payload") == nil {
		collection.Fields.Add(&core.JSONField{Name: "payload", MaxSize: 256 * 1024})
	}
	if collection.Fields.GetByName("created") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true})
	}
	if collection.Fields.GetByName("updated") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true})
	}
	collection.Indexes = removeIndex(collection.Indexes, "idx_sync_events_cursor")
	collection.Indexes = removeIndex(collection.Indexes, "idx_sync_events_user_cursor")
	collection.Indexes = removeIndex(collection.Indexes, "idx_sync_events_conversation_cursor")
	collection.AddIndex("idx_sync_events_cursor", false, "cursor", "")
	collection.AddIndex("idx_sync_events_user_cursor", false, "user, cursor", "")
	collection.AddIndex("idx_sync_events_conversation_cursor", false, "conversation, cursor", "")

	return app.Save(collection)
}

func ensureIdempotencyKeysCollection(app core.App, users *core.Collection, conversations *core.Collection, messages *core.Collection) error {
	collection, err := app.FindCollectionByNameOrId("idempotency_keys")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		collection = core.NewBaseCollection("idempotency_keys")
	}

	collection.ListRule = nil
	collection.ViewRule = nil
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	if collection.Fields.GetByName("user") == nil {
		collection.Fields.Add(&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true})
	}
	if collection.Fields.GetByName("device_id") == nil {
		collection.Fields.Add(&core.TextField{Name: "device_id", Required: true, Max: 160})
	}
	if collection.Fields.GetByName("client_message_id") == nil {
		collection.Fields.Add(&core.TextField{Name: "client_message_id", Required: true, Max: 160})
	}
	if collection.Fields.GetByName("payload_hash") == nil {
		collection.Fields.Add(&core.TextField{Name: "payload_hash", Required: true, Max: 128})
	}
	if collection.Fields.GetByName("message") == nil {
		collection.Fields.Add(&core.RelationField{Name: "message", CollectionId: messages.Id, CascadeDelete: true, MaxSelect: 1, Required: true})
	}
	if collection.Fields.GetByName("conversation") == nil {
		collection.Fields.Add(&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1, Required: true})
	}
	if collection.Fields.GetByName("result_cursor") == nil {
		collection.Fields.Add(&core.NumberField{Name: "result_cursor", OnlyInt: true})
	}
	if collection.Fields.GetByName("created") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true})
	}
	if collection.Fields.GetByName("updated") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true})
	}
	collection.Indexes = removeIndex(collection.Indexes, "idx_idempotency_keys_unique")
	collection.AddIndex("idx_idempotency_keys_unique", true, "user, device_id, client_message_id", "")

	return app.Save(collection)
}

func ensurePushOutboxCollection(app core.App, users *core.Collection, conversations *core.Collection) error {
	collection, err := app.FindCollectionByNameOrId("push_outbox")
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		collection = core.NewBaseCollection("push_outbox")
	}

	collection.ListRule = nil
	collection.ViewRule = nil
	collection.CreateRule = nil
	collection.UpdateRule = nil
	collection.DeleteRule = nil
	if collection.Fields.GetByName("user") == nil {
		collection.Fields.Add(&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true})
	}
	if collection.Fields.GetByName("conversation") == nil {
		collection.Fields.Add(&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1})
	}
	if collection.Fields.GetByName("cursor") == nil {
		collection.Fields.Add(&core.NumberField{Name: "cursor", OnlyInt: true})
	}
	if collection.Fields.GetByName("kind") == nil {
		collection.Fields.Add(&core.SelectField{Name: "kind", Required: true, Values: []string{"message", "call", "sync"}})
	}
	if collection.Fields.GetByName("payload") == nil {
		collection.Fields.Add(&core.JSONField{Name: "payload", MaxSize: 256 * 1024})
	}
	if collection.Fields.GetByName("status") == nil {
		collection.Fields.Add(&core.SelectField{Name: "status", Required: true, Values: []string{"pending", "sending", "sent", "failed", "dead"}})
	}
	if collection.Fields.GetByName("attempt_count") == nil {
		collection.Fields.Add(&core.NumberField{Name: "attempt_count", OnlyInt: true})
	}
	if collection.Fields.GetByName("next_attempt_at") == nil {
		collection.Fields.Add(&core.DateField{Name: "next_attempt_at"})
	}
	if collection.Fields.GetByName("last_error") == nil {
		collection.Fields.Add(&core.TextField{Name: "last_error", Max: 1000})
	}
	if collection.Fields.GetByName("created") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "created", OnCreate: true})
	}
	if collection.Fields.GetByName("updated") == nil {
		collection.Fields.Add(&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true})
	}
	collection.Indexes = removeIndex(collection.Indexes, "idx_push_outbox_status")
	collection.Indexes = removeIndex(collection.Indexes, "idx_push_outbox_user_cursor")
	collection.AddIndex("idx_push_outbox_status", false, "status, next_attempt_at", "")
	collection.AddIndex("idx_push_outbox_user_cursor", false, "user, cursor", "")

	return app.Save(collection)
}

func backfillChatSyncProtocol(app core.App) error {
	if err := ensureGlobalSyncCursor(app); err != nil {
		return err
	}

	stateCollection, err := app.FindCollectionByNameOrId("conversation_user_states")
	if err != nil {
		return err
	}

	conversations, err := app.FindAllRecords("conversations")
	if err != nil {
		return err
	}

	for _, conversation := range conversations {
		messages, err := app.FindRecordsByFilter(
			"messages",
			"conversation={:conversation}",
			"created,id",
			0,
			0,
			dbx.Params{"conversation": conversation.Id},
		)
		if err != nil {
			return err
		}

		messageSeqById := make(map[string]int, len(messages))
		lastMessageId := ""
		lastMessageSeq := 0
		for index, message := range messages {
			seq := message.GetInt("message_seq")
			if seq <= 0 {
				seq = index + 1
				if _, err := app.DB().NewQuery("UPDATE messages SET message_seq={:seq}, edit_version=COALESCE(NULLIF(edit_version, 0), 0) WHERE id={:id}").Bind(dbx.Params{"id": message.Id, "seq": seq}).Execute(); err != nil {
					return err
				}
			}

			messageSeqById[message.Id] = seq
			lastMessageId = message.Id
			lastMessageSeq = seq
		}

		if _, err := app.DB().NewQuery(
			"UPDATE conversations SET next_message_seq={:nextSeq}, last_message_id={:lastMessageId}, last_message_seq={:lastMessageSeq} WHERE id={:conversation}",
		).Bind(dbx.Params{
			"conversation":   conversation.Id,
			"lastMessageId":  lastMessageId,
			"lastMessageSeq": lastMessageSeq,
			"nextSeq":        lastMessageSeq + 1,
		}).Execute(); err != nil {
			return err
		}

		for _, memberId := range conversation.GetStringSlice("members") {
			if _, err := app.FindFirstRecordByFilter(
				"conversation_user_states",
				"conversation={:conversation} && user={:user}",
				dbx.Params{"conversation": conversation.Id, "user": memberId},
			); err == nil {
				continue
			} else if !errors.Is(err, sql.ErrNoRows) {
				return err
			}

			lastReadSeq := 0
			read, err := app.FindFirstRecordByFilter(
				"conversation_reads",
				"conversation={:conversation} && user={:user}",
				dbx.Params{"conversation": conversation.Id, "user": memberId},
			)
			if err == nil {
				lastReadAt := read.GetDateTime("last_read_at")
				for _, message := range messages {
					if !message.GetDateTime("created").Time().After(lastReadAt.Time()) {
						if seq := messageSeqById[message.Id]; seq > lastReadSeq {
							lastReadSeq = seq
						}
					}
				}
			} else if !errors.Is(err, sql.ErrNoRows) {
				return err
			}

			unreadCount := 0
			for _, message := range messages {
				seq := messageSeqById[message.Id]
				if seq > lastReadSeq && message.GetString("sender") != memberId {
					unreadCount += 1
				}
			}

			state := core.NewRecord(stateCollection)
			state.Set("conversation", conversation.Id)
			state.Set("user", memberId)
			state.Set("last_read_seq", lastReadSeq)
			state.Set("unread_count", unreadCount)
			state.Set("last_delivered_cursor", 0)

			if err := app.Save(state); err != nil {
				return err
			}
		}
	}

	return nil
}

func ensureGlobalSyncCursor(app core.App) error {
	if _, err := app.FindFirstRecordByFilter("sync_cursors", "scope={:scope}", dbx.Params{"scope": "global"}); err == nil {
		return nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	collection, err := app.FindCollectionByNameOrId("sync_cursors")
	if err != nil {
		return err
	}

	cursor := core.NewRecord(collection)
	cursor.Set("scope", "global")
	cursor.Set("next_cursor", 1)

	return app.Save(cursor)
}
