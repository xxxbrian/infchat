package migrations

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		for _, name := range []string{
			"call_participants",
			"push_outbox",
			"idempotency_keys",
			"sync_events",
			"sync_cursors",
			"conversation_user_states",
			"conversation_reads",
			"conversation_events",
			"messages",
			"call_rooms",
			"conversation_memberships",
			"conversations",
			"event_cursors",
		} {
			if err := dropCollectionIfExists(app, name); err != nil {
				return err
			}
		}

		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		conversations := core.NewBaseCollection("conversations")
		conversations.ListRule = pointer("@request.auth.id != ''")
		conversations.ViewRule = pointer("@request.auth.id != ''")
		conversations.CreateRule = nil
		conversations.UpdateRule = nil
		conversations.DeleteRule = nil
		conversations.Fields.Add(
			&core.SelectField{Name: "kind", Required: true, Values: []string{"private", "group"}},
			&core.TextField{Name: "pair_key", Max: 80},
			&core.RelationField{Name: "created_by", CollectionId: users.Id, CascadeDelete: false, MaxSelect: 1},
			&core.TextField{Name: "title", Max: 80},
			&core.FileField{Name: "avatar", MaxSelect: 1, MaxSize: 5 * 1024 * 1024, MimeTypes: []string{"image/jpeg", "image/png", "image/webp"}, Thumbs: []string{"160x160"}},
			&core.TextField{Name: "description", Max: 500},
			&core.SelectField{Name: "default_history_policy", Required: true, Values: []string{"full", "since_join"}},
			&core.NumberField{Name: "member_count", OnlyInt: true},
			&core.NumberField{Name: "next_message_seq", OnlyInt: true},
			&core.NumberField{Name: "next_event_seq", OnlyInt: true},
			&core.NumberField{Name: "latest_event_cursor", OnlyInt: true},
			&core.TextField{Name: "last_message_id", Max: 32},
			&core.NumberField{Name: "last_message_seq", OnlyInt: true},
			&core.TextField{Name: "last_message_text", Max: 500},
			&core.DateField{Name: "last_message_at"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		conversations.AddIndex("idx_conversations_private_pair", true, "pair_key", "kind = 'private' AND pair_key != ''")
		conversations.AddIndex("idx_conversations_latest_event_cursor", false, "latest_event_cursor", "")
		conversations.AddIndex("idx_conversations_last_message_seq", false, "last_message_seq", "")
		if err := app.Save(conversations); err != nil {
			return err
		}

		memberships := core.NewBaseCollection("conversation_memberships")
		memberships.ListRule = pointer("@request.auth.id != ''")
		memberships.ViewRule = pointer("@request.auth.id != ''")
		memberships.CreateRule = nil
		memberships.UpdateRule = nil
		memberships.DeleteRule = nil
		memberships.Fields.Add(
			&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.NumberField{Name: "epoch_no", OnlyInt: true},
			&core.SelectField{Name: "role", Required: true, Values: []string{"owner", "admin", "member"}},
			&core.SelectField{Name: "status", Required: true, Values: []string{"active", "left", "removed"}},
			&core.SelectField{Name: "join_source", Required: true, Values: []string{"created", "added_by_member", "invite_link"}},
			&core.RelationField{Name: "added_by", CollectionId: users.Id, CascadeDelete: false, MaxSelect: 1},
			&core.RelationField{Name: "removed_by", CollectionId: users.Id, CascadeDelete: false, MaxSelect: 1},
			&core.NumberField{Name: "joined_message_seq", OnlyInt: true},
			&core.NumberField{Name: "history_start_message_seq", OnlyInt: true},
			&core.NumberField{Name: "live_start_cursor", OnlyInt: true},
			&core.NumberField{Name: "ended_message_seq", OnlyInt: true},
			&core.NumberField{Name: "ended_cursor", OnlyInt: true},
			&core.DateField{Name: "ended_at"},
			&core.NumberField{Name: "last_read_message_seq", OnlyInt: true},
			&core.SelectField{Name: "notification_level", Required: true, Values: []string{"all", "mentions", "muted"}},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		memberships.AddIndex("idx_memberships_active_unique", true, "conversation, user", "status = 'active'")
		memberships.AddIndex("idx_memberships_user_status", false, "user, status, live_start_cursor", "")
		memberships.AddIndex("idx_memberships_conversation_status", false, "conversation, status, role", "")
		memberships.AddIndex("idx_memberships_epoch", false, "conversation, user, epoch_no", "")
		if err := app.Save(memberships); err != nil {
			return err
		}

		membershipScopedConversationRule := "@request.auth.id != '' && @collection.conversation_memberships.conversation ?= id && @collection.conversation_memberships.user ?= @request.auth.id && @collection.conversation_memberships.status ?= 'active'"
		conversations.ListRule = pointer(membershipScopedConversationRule)
		conversations.ViewRule = pointer(membershipScopedConversationRule)
		if err := app.Save(conversations); err != nil {
			return err
		}

		membershipScopedMembershipRule := "@request.auth.id != '' && @collection.conversation_memberships.conversation ?= conversation && @collection.conversation_memberships.user ?= @request.auth.id && @collection.conversation_memberships.status ?= 'active'"
		memberships.ListRule = pointer(membershipScopedMembershipRule)
		memberships.ViewRule = pointer(membershipScopedMembershipRule)
		if err := app.Save(memberships); err != nil {
			return err
		}

		messages := core.NewBaseCollection("messages")
		messages.ListRule = nil
		messages.ViewRule = pointer("@request.auth.id != '' && @collection.conversation_memberships.conversation ?= conversation && @collection.conversation_memberships.user ?= @request.auth.id && @collection.conversation_memberships.status ?= 'active' && message_seq >= @collection.conversation_memberships.history_start_message_seq")
		messages.CreateRule = nil
		messages.UpdateRule = nil
		messages.DeleteRule = nil
		messages.Fields.Add(
			&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "sender", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "sender_membership", CollectionId: memberships.Id, CascadeDelete: false, MaxSelect: 1},
			&core.SelectField{Name: "kind", Required: true, Values: []string{"text", "image", "file", "voice", "call"}},
			&core.TextField{Name: "body", Max: 4000},
			&core.FileField{Name: "attachments", MaxSelect: 5, MaxSize: 25 * 1024 * 1024, Thumbs: []string{"720x720", "320x320"}},
			&core.TextField{Name: "call_room", Max: 32},
			&core.NumberField{Name: "message_seq", OnlyInt: true},
			&core.TextField{Name: "client_message_id", Max: 160},
			&core.TextField{Name: "sender_device_id", Max: 160},
			&core.DateField{Name: "deleted_at"},
			&core.RelationField{Name: "deleted_by", CollectionId: users.Id, CascadeDelete: false, MaxSelect: 1},
			&core.DateField{Name: "edited_at"},
			&core.NumberField{Name: "edit_version", OnlyInt: true},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		messages.AddIndex("idx_messages_conversation_seq", true, "conversation, message_seq", "message_seq > 0")
		messages.AddIndex("idx_messages_client_message", true, "sender, sender_device_id, client_message_id", "client_message_id != '' AND sender_device_id != ''")
		messages.AddIndex("idx_messages_call_room", false, "call_room", "call_room != ''")
		if err := app.Save(messages); err != nil {
			return err
		}

		events := core.NewBaseCollection("conversation_events")
		events.ListRule = nil
		events.ViewRule = nil
		events.CreateRule = nil
		events.UpdateRule = nil
		events.DeleteRule = nil
		events.Fields.Add(
			&core.NumberField{Name: "cursor", Required: true, OnlyInt: true},
			&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.NumberField{Name: "event_seq", Required: true, OnlyInt: true},
			&core.SelectField{Name: "type", Required: true, Values: []string{"conversation.created", "conversation.updated", "conversation.history_policy_updated", "membership.added", "membership.left", "membership.removed", "membership.role_updated", "read.updated", "message.created", "message.edited", "message.deleted", "call.started", "call.updated", "call.ended"}},
			&core.RelationField{Name: "actor_user", CollectionId: users.Id, CascadeDelete: false, MaxSelect: 1},
			&core.RelationField{Name: "actor_membership", CollectionId: memberships.Id, CascadeDelete: false, MaxSelect: 1},
			&core.RelationField{Name: "subject_user", CollectionId: users.Id, CascadeDelete: false, MaxSelect: 1},
			&core.RelationField{Name: "subject_membership", CollectionId: memberships.Id, CascadeDelete: false, MaxSelect: 1},
			&core.RelationField{Name: "message", CollectionId: messages.Id, CascadeDelete: false, MaxSelect: 1},
			&core.JSONField{Name: "payload", MaxSize: 256 * 1024},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		events.AddIndex("idx_conversation_events_cursor", true, "cursor", "")
		events.AddIndex("idx_conversation_events_conversation_cursor", false, "conversation, cursor", "")
		events.AddIndex("idx_conversation_events_subject_cursor", false, "subject_user, cursor", "")
		if err := app.Save(events); err != nil {
			return err
		}

		eventCursors := core.NewBaseCollection("event_cursors")
		eventCursors.ListRule = nil
		eventCursors.ViewRule = nil
		eventCursors.CreateRule = nil
		eventCursors.UpdateRule = nil
		eventCursors.DeleteRule = nil
		eventCursors.Fields.Add(
			&core.TextField{Name: "scope", Required: true, Max: 80},
			&core.NumberField{Name: "next_cursor", Required: true, OnlyInt: true},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		eventCursors.AddIndex("idx_event_cursors_scope", true, "scope", "")
		if err := app.Save(eventCursors); err != nil {
			return err
		}

		if err := createInitialEventCursor(app); err != nil {
			return err
		}

		idempotencyKeys := core.NewBaseCollection("idempotency_keys")
		idempotencyKeys.ListRule = nil
		idempotencyKeys.ViewRule = nil
		idempotencyKeys.CreateRule = nil
		idempotencyKeys.UpdateRule = nil
		idempotencyKeys.DeleteRule = nil
		idempotencyKeys.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.TextField{Name: "device_id", Required: true, Max: 160},
			&core.TextField{Name: "client_message_id", Required: true, Max: 160},
			&core.TextField{Name: "payload_hash", Required: true, Max: 128},
			&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "message", CollectionId: messages.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.NumberField{Name: "result_cursor", OnlyInt: true},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		idempotencyKeys.AddIndex("idx_idempotency_keys_unique", true, "user, device_id, client_message_id", "")
		if err := app.Save(idempotencyKeys); err != nil {
			return err
		}

		pushOutbox := core.NewBaseCollection("push_outbox")
		pushOutbox.ListRule = nil
		pushOutbox.ViewRule = nil
		pushOutbox.CreateRule = nil
		pushOutbox.UpdateRule = nil
		pushOutbox.DeleteRule = nil
		pushOutbox.Fields.Add(
			&core.RelationField{Name: "event", CollectionId: events.Id, CascadeDelete: true, MaxSelect: 1},
			&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1},
			&core.NumberField{Name: "cursor", OnlyInt: true},
			&core.SelectField{Name: "kind", Required: true, Values: []string{"message", "call", "sync"}},
			&core.JSONField{Name: "payload", MaxSize: 256 * 1024},
			&core.SelectField{Name: "status", Required: true, Values: []string{"pending", "sending", "sent", "failed", "dead"}},
			&core.NumberField{Name: "attempt_count", OnlyInt: true},
			&core.DateField{Name: "next_attempt_at"},
			&core.TextField{Name: "last_error", Max: 1000},
			&core.TextField{Name: "dedupe_key", Max: 200},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		pushOutbox.AddIndex("idx_push_outbox_status", false, "status, next_attempt_at", "")
		pushOutbox.AddIndex("idx_push_outbox_dedupe", true, "dedupe_key", "dedupe_key != ''")
		if err := app.Save(pushOutbox); err != nil {
			return err
		}

		callRooms := core.NewBaseCollection("call_rooms")
		callRooms.ListRule = pointer("@request.auth.id != '' && @collection.conversation_memberships.conversation ?= conversation && @collection.conversation_memberships.user ?= @request.auth.id && @collection.conversation_memberships.status ?= 'active'")
		callRooms.ViewRule = pointer("@request.auth.id != '' && @collection.conversation_memberships.conversation ?= conversation && @collection.conversation_memberships.user ?= @request.auth.id && @collection.conversation_memberships.status ?= 'active'")
		callRooms.CreateRule = nil
		callRooms.UpdateRule = nil
		callRooms.DeleteRule = nil
		callRooms.Fields.Add(
			&core.RelationField{Name: "conversation", CollectionId: conversations.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "created_by", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "created_by_membership", CollectionId: memberships.Id, CascadeDelete: false, MaxSelect: 1},
			&core.SelectField{Name: "kind", Required: true, Values: []string{"voice", "video"}},
			&core.TextField{Name: "room_name", Required: true, Max: 160},
			&core.SelectField{Name: "status", Required: true, Values: []string{"ringing", "active", "ended", "missed", "declined", "canceled"}},
			&core.DateField{Name: "ended_at"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		callRooms.AddIndex("idx_call_rooms_conversation_status", false, "conversation, status, created", "")
		callRooms.AddIndex("idx_call_rooms_room_name", true, "room_name", "")
		callRooms.AddIndex("idx_call_rooms_one_open_per_conversation", true, "conversation", "status = 'ringing' OR status = 'active'")
		if err := app.Save(callRooms); err != nil {
			return err
		}

		callParticipants := core.NewBaseCollection("call_participants")
		callParticipants.ListRule = pointer("@request.auth.id != '' && @collection.conversation_memberships.conversation ?= call_room.conversation && @collection.conversation_memberships.user ?= @request.auth.id && @collection.conversation_memberships.status ?= 'active'")
		callParticipants.ViewRule = pointer("@request.auth.id != '' && @collection.conversation_memberships.conversation ?= call_room.conversation && @collection.conversation_memberships.user ?= @request.auth.id && @collection.conversation_memberships.status ?= 'active'")
		callParticipants.CreateRule = nil
		callParticipants.UpdateRule = nil
		callParticipants.DeleteRule = nil
		callParticipants.Fields.Add(
			&core.RelationField{Name: "call_room", CollectionId: callRooms.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "membership", CollectionId: memberships.Id, CascadeDelete: false, MaxSelect: 1},
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
		for _, name := range []string{
			"call_participants",
			"call_rooms",
			"push_outbox",
			"idempotency_keys",
			"conversation_events",
			"messages",
			"conversation_memberships",
			"conversations",
			"event_cursors",
		} {
			if err := dropCollectionIfExists(app, name); err != nil {
				return err
			}
		}

		return nil
	})
}

func dropCollectionIfExists(app core.App, name string) error {
	collection, err := app.FindCollectionByNameOrId(name)
	if err == nil {
		return app.Delete(collection)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}

	return err
}

func createInitialEventCursor(app core.App) error {
	collection, err := app.FindCollectionByNameOrId("event_cursors")
	if err != nil {
		return err
	}

	record := core.NewRecord(collection)
	record.Set("scope", "global")
	record.Set("next_cursor", 1)

	return app.Save(record)
}
