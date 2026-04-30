package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"
)

const chatSyncDefaultLimit = 200
const chatSyncMaxLimit = 500

type sendMessageCommandRequest struct {
	Body            string `json:"body" form:"body"`
	ClientMessageId string `json:"clientMessageId" form:"clientMessageId"`
	ConversationId  string `json:"conversationId" form:"conversationId"`
	DeviceId        string `json:"deviceId" form:"deviceId"`
	Kind            string `json:"kind" form:"kind"`
}

type markConversationReadRequest struct {
	LastReadSeq int `json:"lastReadSeq" form:"lastReadSeq"`
}

type syncEventPayload struct {
	Conversation *core.Record `json:"conversation,omitempty"`
	Message      *core.Record `json:"message,omitempty"`
	ReadState    *core.Record `json:"readState,omitempty"`
}

func bindChatSyncRoutes(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		group := se.Router.Group("/api/infchat")
		group.Bind(apis.RequireAuth("users"))

		group.GET("/bootstrap", func(e *core.RequestEvent) error {
			conversations, err := app.FindRecordsByFilter(
				"conversations",
				"members.id ?= {:userId}",
				"-last_message_seq,-updated",
				0,
				0,
				dbx.Params{"userId": e.Auth.Id},
			)
			if err != nil {
				return err
			}

			states, err := app.FindRecordsByFilter(
				"conversation_user_states",
				"user={:userId}",
				"conversation",
				0,
				0,
				dbx.Params{"userId": e.Auth.Id},
			)
			if err != nil {
				return err
			}

			latestCursor, err := latestSyncCursorForUser(app, e.Auth.Id)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{
				"conversations": conversations,
				"cursor":        latestCursor,
				"states":        states,
			})
		})

		group.GET("/sync", func(e *core.RequestEvent) error {
			cursor := queryInt(e, "cursor", 0)
			limit := requestLimit(e, chatSyncDefaultLimit, chatSyncMaxLimit)

			events, err := app.FindRecordsByFilter(
				"sync_events",
				"user={:userId} && cursor>{:cursor}",
				"cursor",
				limit,
				0,
				dbx.Params{"cursor": cursor, "userId": e.Auth.Id},
			)
			if err != nil {
				return err
			}

			nextCursor := cursor
			for _, event := range events {
				if eventCursor := event.GetInt("cursor"); eventCursor > nextCursor {
					nextCursor = eventCursor
				}
			}

			return e.JSON(http.StatusOK, map[string]any{
				"cursor":  nextCursor,
				"events":  events,
				"hasMore": len(events) == limit,
			})
		})

		group.GET("/conversations/{id}/messages", func(e *core.RequestEvent) error {
			conversation, err := findConversationForChatSync(e.App, e.Request.PathValue("id"), e.Auth.Id)
			if err != nil {
				return err
			}

			beforeSeq := queryInt(e, "beforeSeq", 0)
			limit := requestLimit(e, 50, 200)
			filter := "conversation={:conversation} && deleted_at=''"
			params := dbx.Params{"conversation": conversation.Id}
			if beforeSeq > 0 {
				filter += " && message_seq < {:beforeSeq}"
				params["beforeSeq"] = beforeSeq
			}

			messages, err := app.FindRecordsByFilter("messages", filter, "-message_seq", limit, 0, params)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{"messages": messages})
		})

		group.POST("/messages/send", func(e *core.RequestEvent) error {
			data := sendMessageCommandRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read message data.", err)
			}

			result, err := sendChatMessageCommand(e.App, e.Auth.Id, data)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, result)
		})

		group.POST("/conversations/{id}/read", func(e *core.RequestEvent) error {
			data := markConversationReadRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read receipt data.", err)
			}

			result, err := markConversationReadCommand(e.App, e.Auth.Id, e.Request.PathValue("id"), data.LastReadSeq)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, result)
		})

		return se.Next()
	})
}

func sendChatMessageCommand(app core.App, userId string, data sendMessageCommandRequest) (map[string]any, error) {
	conversation, err := findConversationForChatSync(app, data.ConversationId, userId)
	if err != nil {
		return nil, err
	}

	deviceId := normalizedDeviceId(data.DeviceId)
	clientMessageId := strings.TrimSpace(data.ClientMessageId)
	if clientMessageId == "" {
		return nil, router.NewBadRequestError("clientMessageId is required.", nil)
	}

	kind := strings.TrimSpace(data.Kind)
	if kind == "" {
		kind = "text"
	}
	if kind != "text" {
		return nil, router.NewBadRequestError("Only text messages are supported by the sync command endpoint yet.", nil)
	}

	body := strings.TrimSpace(data.Body)
	if body == "" {
		return nil, router.NewBadRequestError("Message text is required.", nil)
	}

	payloadHash := hashIdempotentMessagePayload(conversation.Id, kind, body)
	if existing, err := app.FindFirstRecordByFilter(
		"idempotency_keys",
		"user={:userId} && device_id={:deviceId} && client_message_id={:clientMessageId}",
		dbx.Params{"clientMessageId": clientMessageId, "deviceId": deviceId, "userId": userId},
	); err == nil {
		if existing.GetString("payload_hash") != payloadHash {
			return nil, router.NewBadRequestError("clientMessageId was already used for a different message.", nil)
		}

		message, err := app.FindRecordById("messages", existing.GetString("message"))
		if err != nil {
			return nil, err
		}

		return map[string]any{
			"conversation": conversation,
			"cursor":       existing.GetInt("result_cursor"),
			"message":      message,
			"replayed":     true,
		}, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	var result map[string]any
	err = app.RunInTransaction(func(txApp core.App) error {
		conversation, err := findConversationForChatSync(txApp, data.ConversationId, userId)
		if err != nil {
			return err
		}

		messageCollection, err := txApp.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}

		messageSeq, err := reserveMessageSeq(txApp, conversation.Id)
		if err != nil {
			return err
		}

		message := core.NewRecord(messageCollection)
		message.Set("conversation", conversation.Id)
		message.Set("sender", userId)
		message.Set("kind", kind)
		message.Set("body", body)
		message.Set("client_message_id", clientMessageId)
		message.Set("sender_device_id", deviceId)
		message.Set("message_seq", messageSeq)
		message.Set("edit_version", 0)

		if err := txApp.Save(message); err != nil {
			return err
		}

		cursor, err := nextSyncCursor(txApp)
		if err != nil {
			return err
		}
		conversation, err = updateConversationPreviewFromMessageWithCursor(txApp, message, message.GetString("created"), cursor)
		if err != nil {
			return err
		}

		if err := persistIdempotencyKey(txApp, userId, deviceId, clientMessageId, payloadHash, conversation.Id, message.Id, cursor); err != nil {
			return err
		}

		if err := emitMessageCreatedEvents(txApp, conversation, message, cursor, userId); err != nil {
			return err
		}

		result = map[string]any{
			"conversation": conversation,
			"cursor":       cursor,
			"message":      message,
			"replayed":     false,
		}

		return nil
	})

	return result, err
}

func markConversationReadCommand(app core.App, userId string, conversationId string, lastReadSeq int) (map[string]any, error) {
	if lastReadSeq < 0 {
		return nil, router.NewBadRequestError("lastReadSeq must be positive.", nil)
	}

	var result map[string]any
	err := app.RunInTransaction(func(txApp core.App) error {
		conversation, err := findConversationForChatSync(txApp, conversationId, userId)
		if err != nil {
			return err
		}

		maxSeq := conversation.GetInt("last_message_seq")
		if lastReadSeq > maxSeq {
			lastReadSeq = maxSeq
		}

		state, err := findOrCreateConversationUserState(txApp, conversation, userId)
		if err != nil {
			return err
		}
		if state.GetInt("last_read_seq") > lastReadSeq {
			lastReadSeq = state.GetInt("last_read_seq")
		}

		unreadCount, err := countUnreadMessagesAfterSeq(txApp, conversation.Id, userId, lastReadSeq)
		if err != nil {
			return err
		}

		state.Set("last_read_seq", lastReadSeq)
		state.Set("unread_count", unreadCount)
		if err := txApp.Save(state); err != nil {
			return err
		}

		cursor, err := nextSyncCursor(txApp)
		if err != nil {
			return err
		}

		state.Set("last_delivered_cursor", cursor)
		if err := txApp.Save(state); err != nil {
			return err
		}
		if err := emitReadUpdatedEvents(txApp, conversation, state, cursor); err != nil {
			return err
		}

		result = map[string]any{"cursor": cursor, "state": state}

		return nil
	})

	return result, err
}

func findConversationForChatSync(app core.App, conversationId string, userId string) (*core.Record, error) {
	if strings.TrimSpace(conversationId) == "" {
		return nil, router.NewBadRequestError("Conversation is required.", nil)
	}

	conversation, err := app.FindRecordById("conversations", conversationId)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, router.NewBadRequestError("Conversation was not found.", nil)
		}

		return nil, err
	}

	if !containsString(conversation.GetStringSlice("members"), userId) {
		return nil, router.NewForbiddenError("You are not a member of this conversation.", nil)
	}

	return conversation, nil
}

func hashIdempotentMessagePayload(conversationId string, kind string, body string) string {
	payload := fmt.Sprintf("%s\x00%s\x00%s", conversationId, kind, body)
	sum := sha256.Sum256([]byte(payload))

	return hex.EncodeToString(sum[:])
}

func nextMessageSeqForConversation(app core.App, conversationId string) int {
	messages, err := app.FindRecordsByFilter(
		"messages",
		"conversation={:conversation} && message_seq>0",
		"-message_seq",
		1,
		0,
		dbx.Params{"conversation": conversationId},
	)
	if err != nil || len(messages) == 0 {
		return 1
	}

	return messages[0].GetInt("message_seq") + 1
}

func reserveMessageSeq(app core.App, conversationId string) (int, error) {
	var messageSeq int
	err := app.DB().NewQuery(
		`UPDATE conversations
         SET next_message_seq = CASE
           WHEN next_message_seq > 0 THEN next_message_seq + 1
           ELSE (SELECT COALESCE(MAX(message_seq), 0) + 2 FROM messages WHERE conversation={:conversation})
         END
         WHERE id={:conversation}
		 RETURNING next_message_seq - 1`,
	).Bind(dbx.Params{"conversation": conversationId}).Row(&messageSeq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, router.NewBadRequestError("Conversation was not found.", nil)
	}

	return messageSeq, err
}

func nextSyncCursor(app core.App) (int, error) {
	cursor, err := app.FindFirstRecordByFilter("sync_cursors", "scope={:scope}", dbx.Params{"scope": "global"})
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return 0, err
		}

		collection, collectionErr := app.FindCollectionByNameOrId("sync_cursors")
		if collectionErr != nil {
			return 0, collectionErr
		}

		cursor = core.NewRecord(collection)
		cursor.Set("scope", "global")
		cursor.Set("next_cursor", 1)
	}

	nextCursor := cursor.GetInt("next_cursor")
	if nextCursor <= 0 {
		nextCursor = 1
	}
	cursor.Set("next_cursor", nextCursor+1)

	return nextCursor, app.Save(cursor)
}

func persistIdempotencyKey(app core.App, userId string, deviceId string, clientMessageId string, payloadHash string, conversationId string, messageId string, cursor int) error {
	collection, err := app.FindCollectionByNameOrId("idempotency_keys")
	if err != nil {
		return err
	}

	record := core.NewRecord(collection)
	record.Set("user", userId)
	record.Set("device_id", deviceId)
	record.Set("client_message_id", clientMessageId)
	record.Set("payload_hash", payloadHash)
	record.Set("conversation", conversationId)
	record.Set("message", messageId)
	record.Set("result_cursor", cursor)

	return app.Save(record)
}

func emitMessageCreatedEvents(app core.App, conversation *core.Record, message *core.Record, cursor int, senderId string) error {
	for _, memberId := range conversation.GetStringSlice("members") {
		state, err := findOrCreateConversationUserState(app, conversation, memberId)
		if err != nil {
			return err
		}

		if memberId != senderId {
			state.Set("unread_count", state.GetInt("unread_count")+1)
		}
		state.Set("last_delivered_cursor", cursor)
		if err := app.Save(state); err != nil {
			return err
		}

		if err := createSyncEvent(app, memberId, conversation.Id, "message.created", message.Id, cursor, syncEventPayload{Conversation: conversation, Message: message, ReadState: state}); err != nil {
			return err
		}
		if memberId != senderId {
			if err := enqueueMessagePush(app, memberId, conversation.Id, cursor, message); err != nil {
				return err
			}
		}
	}

	return nil
}

func emitConversationUpdatedEvents(app core.App, conversation *core.Record, cursor int) error {
	conversation.Set("last_change_cursor", cursor)
	if err := app.Save(conversation); err != nil {
		return err
	}

	for _, memberId := range conversation.GetStringSlice("members") {
		state, err := findOrCreateConversationUserState(app, conversation, memberId)
		if err != nil {
			return err
		}
		state.Set("last_delivered_cursor", cursor)
		if err := app.Save(state); err != nil {
			return err
		}

		if err := createSyncEvent(app, memberId, conversation.Id, "conversation.updated", conversation.Id, cursor, syncEventPayload{Conversation: conversation, ReadState: state}); err != nil {
			return err
		}
	}

	return nil
}

func emitMessageUpdatedEvents(app core.App, conversation *core.Record, message *core.Record, cursor int) error {
	for _, memberId := range conversation.GetStringSlice("members") {
		state, err := findOrCreateConversationUserState(app, conversation, memberId)
		if err != nil {
			return err
		}

		state.Set("last_delivered_cursor", cursor)
		if err := app.Save(state); err != nil {
			return err
		}

		if err := createSyncEvent(app, memberId, conversation.Id, "message.updated", message.Id, cursor, syncEventPayload{Conversation: conversation, Message: message, ReadState: state}); err != nil {
			return err
		}
	}

	return nil
}

func emitReadUpdatedEvents(app core.App, conversation *core.Record, readState *core.Record, cursor int) error {
	for _, memberId := range conversation.GetStringSlice("members") {
		memberState, err := findOrCreateConversationUserState(app, conversation, memberId)
		if err != nil {
			return err
		}
		memberState.Set("last_delivered_cursor", cursor)
		if err := app.Save(memberState); err != nil {
			return err
		}

		if err := createSyncEvent(app, memberId, conversation.Id, "read.updated", readState.Id, cursor, syncEventPayload{ReadState: readState}); err != nil {
			return err
		}
	}

	return nil
}

func findOrCreateConversationUserState(app core.App, conversation *core.Record, userId string) (*core.Record, error) {
	state, err := app.FindFirstRecordByFilter(
		"conversation_user_states",
		"conversation={:conversation} && user={:user}",
		dbx.Params{"conversation": conversation.Id, "user": userId},
	)
	if err == nil {
		return state, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	collection, err := app.FindCollectionByNameOrId("conversation_user_states")
	if err != nil {
		return nil, err
	}

	state = core.NewRecord(collection)
	state.Set("conversation", conversation.Id)
	state.Set("user", userId)
	state.Set("last_read_seq", 0)
	state.Set("unread_count", 0)
	state.Set("last_delivered_cursor", 0)

	if err := app.Save(state); err != nil {
		return nil, err
	}

	return state, nil
}

func createSyncEvent(app core.App, userId string, conversationId string, eventType string, entityId string, cursor int, payload syncEventPayload) error {
	collection, err := app.FindCollectionByNameOrId("sync_events")
	if err != nil {
		return err
	}

	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	event := core.NewRecord(collection)
	event.Set("user", userId)
	event.Set("conversation", conversationId)
	event.Set("type", eventType)
	event.Set("entity_id", entityId)
	event.Set("cursor", cursor)
	event.Set("payload", string(payloadJSON))

	return app.Save(event)
}

func enqueueMessagePush(app core.App, userId string, conversationId string, cursor int, message *core.Record) error {
	collection, err := app.FindCollectionByNameOrId("push_outbox")
	if err != nil {
		return err
	}

	payload := map[string]any{
		"conversationId": conversationId,
		"cursor":         cursor,
		"messageId":      message.Id,
		"type":           "sync_hint",
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	outbox := core.NewRecord(collection)
	outbox.Set("user", userId)
	outbox.Set("conversation", conversationId)
	outbox.Set("cursor", cursor)
	outbox.Set("kind", "message")
	outbox.Set("payload", string(payloadJSON))
	outbox.Set("status", "pending")
	outbox.Set("attempt_count", 0)
	outbox.Set("next_attempt_at", types.NowDateTime())

	return app.Save(outbox)
}

func countUnreadMessagesAfterSeq(app core.App, conversationId string, userId string, lastReadSeq int) (int, error) {
	var total int
	err := app.DB().NewQuery(
		"SELECT COUNT(*) FROM messages WHERE conversation={:conversation} AND sender!={:user} AND message_seq>{:lastReadSeq} AND deleted_at=''",
	).Bind(dbx.Params{"conversation": conversationId, "lastReadSeq": lastReadSeq, "user": userId}).Row(&total)

	return total, err
}

func latestSyncCursorForUser(app core.App, userId string) (int, error) {
	events, err := app.FindRecordsByFilter(
		"sync_events",
		"user={:user}",
		"-cursor",
		1,
		0,
		dbx.Params{"user": userId},
	)
	if err != nil {
		return 0, err
	}
	if len(events) == 0 {
		return 0, nil
	}

	return events[0].GetInt("cursor"), nil
}

func queryInt(e *core.RequestEvent, key string, fallback int) int {
	value := strings.TrimSpace(e.Request.URL.Query().Get(key))
	if value == "" {
		return fallback
	}

	var result int
	if _, err := fmt.Sscanf(value, "%d", &result); err != nil {
		return fallback
	}

	return result
}
