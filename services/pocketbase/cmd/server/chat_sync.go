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
const defaultGroupLimit = 50

var errIdempotentMessageReplay = errors.New("idempotent message replay")

type startPrivateConversationRequest struct {
	RecipientUserId string `json:"recipientUserId" form:"recipientUserId"`
}

type createGroupRequest struct {
	DefaultHistoryPolicy string   `json:"defaultHistoryPolicy" form:"defaultHistoryPolicy"`
	MemberUserIds        []string `json:"memberUserIds" form:"memberUserIds"`
	Title                string   `json:"title" form:"title"`
}

type addGroupMembersRequest struct {
	MemberUserIds []string `json:"memberUserIds" form:"memberUserIds"`
}

type updateGroupRequest struct {
	DefaultHistoryPolicy *string `json:"defaultHistoryPolicy" form:"defaultHistoryPolicy"`
	Description          *string `json:"description" form:"description"`
	Title                *string `json:"title" form:"title"`
}

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

type deleteMessagesRequest struct {
	MessageIds []string `json:"messageIds" form:"messageIds"`
}

type conversationEventPayload struct {
	Conversation *core.Record   `json:"conversation,omitempty"`
	Membership   *core.Record   `json:"membership,omitempty"`
	Memberships  []*core.Record `json:"memberships,omitempty"`
	Message      *core.Record   `json:"message,omitempty"`
	Removed      bool           `json:"removed,omitempty"`
}

func bindChatSyncRoutes(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		group := se.Router.Group("/api/infchat")
		group.Bind(apis.RequireAuth("users"))

		group.GET("/bootstrap", func(e *core.RequestEvent) error {
			cursor, err := latestConversationEventCursor(e.App)
			if err != nil {
				return err
			}

			userMemberships, err := findActiveMembershipsForUser(e.App, e.Auth.Id)
			if err != nil {
				return err
			}

			conversations, err := conversationsForMemberships(e.App, userMemberships)
			if err != nil {
				return err
			}

			memberships, err := activeMembershipsForConversations(e.App, conversations)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{
				"conversations": conversations,
				"cursor":        cursor,
				"memberships":   memberships,
			})
		})

		group.GET("/sync", func(e *core.RequestEvent) error {
			cursor := queryInt(e, "cursor", 0)
			limit := requestLimit(e, chatSyncDefaultLimit, chatSyncMaxLimit)

			events, nextCursor, hasMore, err := visibleConversationEvents(e.App, e.Auth.Id, cursor, limit)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{
				"cursor":  nextCursor,
				"events":  events,
				"hasMore": hasMore,
			})
		})

		group.POST("/conversations/private/start", func(e *core.RequestEvent) error {
			data := startPrivateConversationRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read private conversation data.", err)
			}

			conversation, membership, memberships, cursor, err := startPrivateConversationCommand(e.App, e.Auth.Id, data.RecipientUserId)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{
				"conversation": conversation,
				"cursor":       cursor,
				"membership":   membership,
				"memberships":  memberships,
			})
		})

		group.POST("/groups/create", func(e *core.RequestEvent) error {
			data := createGroupRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read group data.", err)
			}

			conversation, membership, memberships, cursor, err := createGroupConversationCommand(e.App, e.Auth.Id, data)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{
				"conversation": conversation,
				"cursor":       cursor,
				"membership":   membership,
				"memberships":  memberships,
			})
		})

		group.POST("/groups/{id}/members/add", func(e *core.RequestEvent) error {
			data := addGroupMembersRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read group members data.", err)
			}

			result, err := addGroupMembersCommand(e.App, e.Auth.Id, e.Request.PathValue("id"), data.MemberUserIds)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, result)
		})

		group.POST("/groups/{id}/members/{userId}/remove", func(e *core.RequestEvent) error {
			result, err := removeGroupMemberCommand(e.App, e.Auth.Id, e.Request.PathValue("id"), e.Request.PathValue("userId"))
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, result)
		})

		group.POST("/groups/{id}/leave", func(e *core.RequestEvent) error {
			result, err := leaveGroupCommand(e.App, e.Auth.Id, e.Request.PathValue("id"))
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, result)
		})

		group.PATCH("/groups/{id}", func(e *core.RequestEvent) error {
			data := updateGroupRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read group update data.", err)
			}

			result, err := updateGroupCommand(e.App, e.Auth.Id, e.Request.PathValue("id"), data)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, result)
		})

		group.GET("/conversations/{id}/messages", func(e *core.RequestEvent) error {
			conversation, membership, err := findActiveConversationMembership(e.App, e.Request.PathValue("id"), e.Auth.Id)
			if err != nil {
				return err
			}

			beforeSeq := queryInt(e, "beforeSeq", 0)
			limit := requestLimit(e, 50, 200)
			filter := "conversation={:conversation} && deleted_at='' && message_seq >= {:historyStartSeq}"
			params := dbx.Params{"conversation": conversation.Id, "historyStartSeq": membership.GetInt("history_start_message_seq")}
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

		group.GET("/messages/{id}/readers", func(e *core.RequestEvent) error {
			result, err := messageReadersCommand(e.App, e.Auth.Id, e.Request.PathValue("id"))
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, result)
		})

		group.POST("/conversations/{id}/messages/delete", func(e *core.RequestEvent) error {
			data := deleteMessagesRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read delete message data.", err)
			}

			result, err := deleteChatMessagesCommand(e.App, e.Auth.Id, e.Request.PathValue("id"), data.MessageIds)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, result)
		})

		return se.Next()
	})
}

func startPrivateConversationCommand(app core.App, userId string, recipientUserId string) (*core.Record, *core.Record, []*core.Record, int, error) {
	recipientUserId = strings.TrimSpace(recipientUserId)
	if recipientUserId == "" || recipientUserId == userId {
		return nil, nil, nil, 0, router.NewBadRequestError("Recipient is required.", nil)
	}
	if err := ensureAcceptedFriendship(app, userId, recipientUserId); err != nil {
		return nil, nil, nil, 0, err
	}

	pairKey := friendshipPairKey(userId, recipientUserId)
	if existing, err := app.FindFirstRecordByFilter("conversations", "kind='private' && pair_key={:pairKey}", dbx.Params{"pairKey": pairKey}); err == nil {
		membership, err := findActiveMembershipByConversation(app, existing.Id, userId)
		if err != nil {
			return nil, nil, nil, 0, err
		}
		memberships, err := activeMembershipsForConversations(app, []*core.Record{existing})
		if err != nil {
			return nil, nil, nil, 0, err
		}
		cursor, err := latestConversationEventCursor(app)
		return existing, membership, memberships, cursor, err
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, nil, nil, 0, err
	}

	var conversation *core.Record
	var membership *core.Record
	var memberships []*core.Record
	var cursor int
	err := app.RunInTransaction(func(txApp core.App) error {
		conversationCollection, err := txApp.FindCollectionByNameOrId("conversations")
		if err != nil {
			return err
		}
		conversation = core.NewRecord(conversationCollection)
		conversation.Set("kind", "private")
		conversation.Set("pair_key", pairKey)
		conversation.Set("created_by", userId)
		conversation.Set("title", "")
		conversation.Set("default_history_policy", "full")
		conversation.Set("member_count", 2)
		conversation.Set("next_message_seq", 1)
		conversation.Set("next_event_seq", 1)
		conversation.Set("latest_event_cursor", 0)
		if err := txApp.Save(conversation); err != nil {
			return err
		}

		cursor, err = nextConversationEventCursor(txApp)
		if err != nil {
			return err
		}
		ownerMembership, err := createMembershipRecord(txApp, conversation, userId, userId, "member", "created", 0, 1, cursor)
		if err != nil {
			return err
		}
		recipientMembership, err := createMembershipRecord(txApp, conversation, recipientUserId, userId, "member", "created", 0, 1, cursor)
		if err != nil {
			return err
		}
		membership = ownerMembership
		memberships = []*core.Record{ownerMembership, recipientMembership}

		return createConversationEvent(txApp, conversation, "conversation.created", userId, membership.Id, "", "", "", cursor, conversationEventPayload{Conversation: conversation, Membership: membership, Memberships: memberships})
	})

	return conversation, membership, memberships, cursor, err
}

func createGroupConversationCommand(app core.App, userId string, data createGroupRequest) (*core.Record, *core.Record, []*core.Record, int, error) {
	title := strings.TrimSpace(data.Title)
	if title == "" {
		return nil, nil, nil, 0, router.NewBadRequestError("Group title is required.", nil)
	}
	if len([]rune(title)) > 80 {
		return nil, nil, nil, 0, router.NewBadRequestError("Group title is too long.", nil)
	}
	historyPolicy := normalizeHistoryPolicy(data.DefaultHistoryPolicy)
	memberIds := uniqueStrings(append(data.MemberUserIds, userId))
	if len(memberIds) < 2 {
		return nil, nil, nil, 0, router.NewBadRequestError("Choose at least one member.", nil)
	}
	if len(memberIds) > defaultGroupLimit {
		return nil, nil, nil, 0, router.NewBadRequestError("Groups support up to 50 members.", nil)
	}
	for _, memberId := range memberIds {
		if memberId == userId {
			continue
		}
		if err := ensureAcceptedFriendship(app, userId, memberId); err != nil {
			return nil, nil, nil, 0, err
		}
	}

	var conversation *core.Record
	var membership *core.Record
	var memberships []*core.Record
	var cursor int
	err := app.RunInTransaction(func(txApp core.App) error {
		conversationCollection, err := txApp.FindCollectionByNameOrId("conversations")
		if err != nil {
			return err
		}
		conversation = core.NewRecord(conversationCollection)
		conversation.Set("kind", "group")
		conversation.Set("created_by", userId)
		conversation.Set("title", title)
		conversation.Set("default_history_policy", historyPolicy)
		conversation.Set("member_count", len(memberIds))
		conversation.Set("next_message_seq", 1)
		conversation.Set("next_event_seq", 1)
		conversation.Set("latest_event_cursor", 0)
		if err := txApp.Save(conversation); err != nil {
			return err
		}

		cursor, err = nextConversationEventCursor(txApp)
		if err != nil {
			return err
		}
		for _, memberId := range memberIds {
			role := "member"
			if memberId == userId {
				role = "owner"
			}
			nextMembership, err := createMembershipRecord(txApp, conversation, memberId, userId, role, "created", 0, 1, cursor)
			if err != nil {
				return err
			}
			memberships = append(memberships, nextMembership)
			if memberId == userId {
				membership = nextMembership
			}
		}

		return createConversationEvent(txApp, conversation, "conversation.created", userId, membership.Id, "", "", "", cursor, conversationEventPayload{Conversation: conversation, Membership: membership, Memberships: memberships})
	})

	return conversation, membership, memberships, cursor, err
}

func addGroupMembersCommand(app core.App, actorId string, conversationId string, memberUserIds []string) (map[string]any, error) {
	conversation, actorMembership, err := findActiveConversationMembership(app, conversationId, actorId)
	if err != nil {
		return nil, err
	}
	if conversation.GetString("kind") != "group" {
		return nil, router.NewBadRequestError("Only group conversations can add members.", nil)
	}
	if !membershipCanManageMembers(actorMembership) {
		return nil, router.NewForbiddenError("Only group admins can add members.", nil)
	}

	memberUserIds = uniqueStrings(memberUserIds)
	if len(memberUserIds) == 0 {
		return nil, router.NewBadRequestError("Choose at least one member.", nil)
	}
	if conversation.GetInt("member_count")+len(memberUserIds) > defaultGroupLimit {
		return nil, router.NewBadRequestError("Groups support up to 50 members.", nil)
	}
	for _, memberId := range memberUserIds {
		if memberId == actorId {
			return nil, router.NewBadRequestError("You are already in this group.", nil)
		}
		if err := ensureAcceptedFriendship(app, actorId, memberId); err != nil {
			return nil, err
		}
	}

	var added []*core.Record
	var cursor int
	err = app.RunInTransaction(func(txApp core.App) error {
		conversation, actorMembership, err = findActiveConversationMembership(txApp, conversationId, actorId)
		if err != nil {
			return err
		}
		cursor, err = nextConversationEventCursor(txApp)
		if err != nil {
			return err
		}
		historyStartSeq := membershipHistoryStartSeq(conversation)
		for _, memberId := range memberUserIds {
			if _, err := findActiveMembershipByConversation(txApp, conversation.Id, memberId); err == nil {
				continue
			} else if !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			membership, err := createMembershipRecord(txApp, conversation, memberId, actorId, "member", "added_by_member", conversation.GetInt("last_message_seq"), historyStartSeq, cursor)
			if err != nil {
				return err
			}
			added = append(added, membership)
			if err := createConversationEvent(txApp, conversation, "membership.added", actorId, actorMembership.Id, memberId, membership.Id, "", cursor, conversationEventPayload{Conversation: conversation, Membership: membership}); err != nil {
				return err
			}
		}
		conversation.Set("member_count", countActiveMemberships(txApp, conversation.Id))
		conversation.Set("latest_event_cursor", cursor)
		return txApp.Save(conversation)
	})

	return map[string]any{"conversation": conversation, "cursor": cursor, "memberships": added}, err
}

func removeGroupMemberCommand(app core.App, actorId string, conversationId string, userId string) (map[string]any, error) {
	conversation, actorMembership, err := findActiveConversationMembership(app, conversationId, actorId)
	if err != nil {
		return nil, err
	}
	if conversation.GetString("kind") != "group" {
		return nil, router.NewBadRequestError("Only group members can be removed.", nil)
	}
	if !membershipCanManageMembers(actorMembership) {
		return nil, router.NewForbiddenError("Only group admins can remove members.", nil)
	}
	targetMembership, err := findActiveMembershipByConversation(app, conversation.Id, userId)
	if err != nil {
		return nil, router.NewBadRequestError("Member was not found.", nil)
	}
	if targetMembership.GetString("role") == "owner" {
		return nil, router.NewForbiddenError("The owner cannot be removed.", nil)
	}
	if actorMembership.GetString("role") == "admin" && targetMembership.GetString("role") == "admin" {
		return nil, router.NewForbiddenError("Admins cannot remove other admins.", nil)
	}

	var cursor int
	err = app.RunInTransaction(func(txApp core.App) error {
		conversation, actorMembership, err = findActiveConversationMembership(txApp, conversationId, actorId)
		if err != nil {
			return err
		}
		targetMembership, err = findActiveMembershipByConversation(txApp, conversation.Id, userId)
		if err != nil {
			return err
		}
		cursor, err = nextConversationEventCursor(txApp)
		if err != nil {
			return err
		}
		if err := endMembership(txApp, conversation, targetMembership, actorId, "removed", cursor); err != nil {
			return err
		}
		if err := createConversationEvent(txApp, conversation, "membership.removed", actorId, actorMembership.Id, userId, targetMembership.Id, "", cursor, conversationEventPayload{Conversation: conversation, Membership: targetMembership, Removed: true}); err != nil {
			return err
		}
		conversation.Set("member_count", countActiveMemberships(txApp, conversation.Id))
		conversation.Set("latest_event_cursor", cursor)
		return txApp.Save(conversation)
	})

	return map[string]any{"conversation": conversation, "cursor": cursor, "membership": targetMembership}, err
}

func leaveGroupCommand(app core.App, userId string, conversationId string) (map[string]any, error) {
	conversation, membership, err := findActiveConversationMembership(app, conversationId, userId)
	if err != nil {
		return nil, err
	}
	if conversation.GetString("kind") != "group" {
		return nil, router.NewBadRequestError("Only group conversations can be left.", nil)
	}
	if membership.GetString("role") == "owner" && conversation.GetInt("member_count") > 1 {
		return nil, router.NewBadRequestError("Transfer ownership before leaving this group.", nil)
	}

	var cursor int
	err = app.RunInTransaction(func(txApp core.App) error {
		conversation, membership, err = findActiveConversationMembership(txApp, conversationId, userId)
		if err != nil {
			return err
		}
		cursor, err = nextConversationEventCursor(txApp)
		if err != nil {
			return err
		}
		if err := endMembership(txApp, conversation, membership, userId, "left", cursor); err != nil {
			return err
		}
		if err := createConversationEvent(txApp, conversation, "membership.left", userId, membership.Id, userId, membership.Id, "", cursor, conversationEventPayload{Conversation: conversation, Membership: membership, Removed: true}); err != nil {
			return err
		}
		conversation.Set("member_count", countActiveMemberships(txApp, conversation.Id))
		conversation.Set("latest_event_cursor", cursor)
		return txApp.Save(conversation)
	})

	return map[string]any{"conversation": conversation, "cursor": cursor, "membership": membership}, err
}

func updateGroupCommand(app core.App, actorId string, conversationId string, data updateGroupRequest) (map[string]any, error) {
	conversation, membership, err := findActiveConversationMembership(app, conversationId, actorId)
	if err != nil {
		return nil, err
	}
	if conversation.GetString("kind") != "group" {
		return nil, router.NewBadRequestError("Only group conversations can be updated.", nil)
	}
	if !membershipCanManageGroup(membership) {
		return nil, router.NewForbiddenError("Only group admins can update this group.", nil)
	}

	var cursor int
	err = app.RunInTransaction(func(txApp core.App) error {
		conversation, membership, err = findActiveConversationMembership(txApp, conversationId, actorId)
		if err != nil {
			return err
		}
		if data.Title != nil {
			title := strings.TrimSpace(*data.Title)
			if title == "" {
				return router.NewBadRequestError("Group title is required.", nil)
			}
			conversation.Set("title", title)
		}
		if data.Description != nil {
			conversation.Set("description", strings.TrimSpace(*data.Description))
		}
		if data.DefaultHistoryPolicy != nil {
			conversation.Set("default_history_policy", normalizeHistoryPolicy(*data.DefaultHistoryPolicy))
		}
		cursor, err = nextConversationEventCursor(txApp)
		if err != nil {
			return err
		}
		conversation.Set("latest_event_cursor", cursor)
		if err := txApp.Save(conversation); err != nil {
			return err
		}

		return createConversationEvent(txApp, conversation, "conversation.updated", actorId, membership.Id, "", "", "", cursor, conversationEventPayload{Conversation: conversation})
	})

	return map[string]any{"conversation": conversation, "cursor": cursor}, err
}

func sendChatMessageCommand(app core.App, userId string, data sendMessageCommandRequest) (map[string]any, error) {
	conversation, membership, err := findActiveConversationMembership(app, data.ConversationId, userId)
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
		return nil, router.NewBadRequestError("Only text messages are supported by the command endpoint yet.", nil)
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
		conversation, err := app.FindRecordById("conversations", existing.GetString("conversation"))
		if err != nil {
			return nil, err
		}

		return map[string]any{"conversation": conversation, "cursor": existing.GetInt("result_cursor"), "membership": membership, "message": message, "replayed": true}, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	var result map[string]any
	var messageForPush *core.Record
	err = app.RunInTransaction(func(txApp core.App) error {
		conversation, membership, err = findActiveConversationMembership(txApp, data.ConversationId, userId)
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
		cursor, err := nextConversationEventCursor(txApp)
		if err != nil {
			return err
		}

		message := core.NewRecord(messageCollection)
		message.Set("conversation", conversation.Id)
		message.Set("sender", userId)
		message.Set("sender_membership", membership.Id)
		message.Set("kind", kind)
		message.Set("body", body)
		message.Set("client_message_id", clientMessageId)
		message.Set("sender_device_id", deviceId)
		message.Set("message_seq", messageSeq)
		message.Set("edit_version", 0)
		if err := txApp.Save(message); err != nil {
			return err
		}

		conversation, err = updateConversationPreviewFromMessageWithCursor(txApp, message, message.GetString("created"), cursor)
		if err != nil {
			return err
		}
		if err := persistIdempotencyKey(txApp, userId, deviceId, clientMessageId, payloadHash, conversation.Id, message.Id, cursor); err != nil {
			if _, replayErr := replayIdempotentMessage(txApp, userId, deviceId, clientMessageId, payloadHash); replayErr == nil {
				return errIdempotentMessageReplay
			}
			return err
		}
		if err := createConversationEvent(txApp, conversation, "message.created", userId, membership.Id, "", "", message.Id, cursor, conversationEventPayload{Conversation: conversation, Membership: membership, Message: message}); err != nil {
			return err
		}

		result = map[string]any{"conversation": conversation, "cursor": cursor, "membership": membership, "message": message, "replayed": false}
		messageForPush = message
		return nil
	})
	if errors.Is(err, errIdempotentMessageReplay) {
		return replayIdempotentMessage(app, userId, deviceId, clientMessageId, payloadHash)
	}
	if err != nil {
		return nil, err
	}
	if messageForPush != nil {
		go sendMessagePushNotifications(app, messageForPush)
	}

	return result, nil
}

func replayIdempotentMessage(app core.App, userId string, deviceId string, clientMessageId string, payloadHash string) (map[string]any, error) {
	existing, err := app.FindFirstRecordByFilter(
		"idempotency_keys",
		"user={:userId} && device_id={:deviceId} && client_message_id={:clientMessageId}",
		dbx.Params{"clientMessageId": clientMessageId, "deviceId": deviceId, "userId": userId},
	)
	if err != nil {
		return nil, err
	}
	if existing.GetString("payload_hash") != payloadHash {
		return nil, router.NewBadRequestError("clientMessageId was already used for a different message.", nil)
	}

	message, err := app.FindRecordById("messages", existing.GetString("message"))
	if err != nil {
		return nil, err
	}
	conversation, err := app.FindRecordById("conversations", existing.GetString("conversation"))
	if err != nil {
		return nil, err
	}
	membership, err := findActiveMembershipByConversation(app, conversation.Id, userId)
	if err != nil {
		return nil, err
	}

	return map[string]any{"conversation": conversation, "cursor": existing.GetInt("result_cursor"), "membership": membership, "message": message, "replayed": true}, nil
}

func markConversationReadCommand(app core.App, userId string, conversationId string, lastReadSeq int) (map[string]any, error) {
	if lastReadSeq < 0 {
		return nil, router.NewBadRequestError("lastReadSeq must be positive.", nil)
	}

	var membership *core.Record
	err := app.RunInTransaction(func(txApp core.App) error {
		conversation, currentMembership, err := findActiveConversationMembership(txApp, conversationId, userId)
		if err != nil {
			return err
		}
		maxSeq := conversation.GetInt("last_message_seq")
		if lastReadSeq > maxSeq {
			lastReadSeq = maxSeq
		}
		if currentMembership.GetInt("last_read_message_seq") > lastReadSeq {
			lastReadSeq = currentMembership.GetInt("last_read_message_seq")
		}
		currentMembership.Set("last_read_message_seq", lastReadSeq)
		if err := txApp.Save(currentMembership); err != nil {
			return err
		}
		membership = currentMembership
		return nil
	})

	return map[string]any{"membership": membership}, err
}

func messageReadersCommand(app core.App, userId string, messageId string) (map[string]any, error) {
	message, err := app.FindRecordById("messages", strings.TrimSpace(messageId))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, router.NewBadRequestError("Message was not found.", nil)
		}
		return nil, err
	}
	if message.GetString("sender") != userId {
		return nil, router.NewForbiddenError("You can only view readers for your own messages.", nil)
	}
	_, _, err = findActiveConversationMembership(app, message.GetString("conversation"), userId)
	if err != nil {
		return nil, err
	}

	readers, err := app.FindRecordsByFilter(
		"conversation_memberships",
		"conversation={:conversation} && status='active' && user!={:userId} && last_read_message_seq >= {:messageSeq}",
		"updated",
		0,
		0,
		dbx.Params{"conversation": message.GetString("conversation"), "messageSeq": message.GetInt("message_seq"), "userId": userId},
	)
	if err != nil {
		return nil, err
	}

	return map[string]any{"readers": readers, "seenCount": len(readers)}, nil
}

func deleteChatMessagesCommand(app core.App, userId string, conversationId string, messageIds []string) (map[string]any, error) {
	messageIds = uniqueStrings(messageIds)
	if len(messageIds) == 0 {
		return nil, router.NewBadRequestError("messageIds is required.", nil)
	}
	if len(messageIds) > 100 {
		return nil, router.NewBadRequestError("Too many messages to delete.", nil)
	}

	var result map[string]any
	err := app.RunInTransaction(func(txApp core.App) error {
		conversation, membership, err := findActiveConversationMembership(txApp, conversationId, userId)
		if err != nil {
			return err
		}
		deletedMessages := make([]*core.Record, 0, len(messageIds))
		lastCursor := 0
		for _, messageId := range messageIds {
			message, err := txApp.FindRecordById("messages", messageId)
			if err != nil {
				if errors.Is(err, sql.ErrNoRows) {
					return router.NewBadRequestError("Message was not found.", nil)
				}
				return err
			}
			if message.GetString("conversation") != conversation.Id {
				return router.NewBadRequestError("Message does not belong to this conversation.", nil)
			}
			if message.GetString("sender") != userId && !membershipCanDeleteAnyMessage(membership) {
				return router.NewForbiddenError("Only group admins can delete other members' messages.", nil)
			}
			if message.GetString("deleted_at") != "" {
				continue
			}

			message.Set("deleted_at", types.NowDateTime())
			message.Set("deleted_by", userId)
			if err := txApp.Save(message); err != nil {
				return err
			}
			conversation, err = updateConversationPreviewAfterMessageDelete(txApp, conversation, message)
			if err != nil {
				return err
			}
			cursor, err := nextConversationEventCursor(txApp)
			if err != nil {
				return err
			}
			lastCursor = cursor
			conversation.Set("latest_event_cursor", cursor)
			if err := txApp.Save(conversation); err != nil {
				return err
			}
			if err := createConversationEvent(txApp, conversation, "message.deleted", userId, membership.Id, "", "", message.Id, cursor, conversationEventPayload{Conversation: conversation, Message: message}); err != nil {
				return err
			}
			deletedMessages = append(deletedMessages, message)
		}
		if lastCursor == 0 {
			lastCursor, err = latestConversationEventCursor(txApp)
			if err != nil {
				return err
			}
		}
		result = map[string]any{"conversation": conversation, "cursor": lastCursor, "messages": deletedMessages}
		return nil
	})

	return result, err
}

func visibleConversationEvents(app core.App, userId string, cursor int, limit int) ([]*core.Record, int, bool, error) {
	memberships, err := findActiveMembershipsForUser(app, userId)
	if err != nil {
		return nil, cursor, false, err
	}
	clauses := make([]string, 0, len(memberships)+1)
	params := dbx.Params{"cursor": cursor, "userId": userId}
	for index, membership := range memberships {
		conversationKey := fmt.Sprintf("conversation%d", index)
		liveStartKey := fmt.Sprintf("liveStart%d", index)
		clauses = append(clauses, fmt.Sprintf("(conversation={:%s} && cursor>{:cursor} && cursor >= {:%s})", conversationKey, liveStartKey))
		params[conversationKey] = membership.GetString("conversation")
		params[liveStartKey] = membership.GetInt("live_start_cursor")
	}
	clauses = append(clauses, "(subject_user={:userId} && cursor>{:cursor} && (type='membership.left' || type='membership.removed'))")
	filter := strings.Join(clauses, " || ")
	if filter == "" {
		filter = "subject_user={:userId} && cursor>{:cursor} && (type='membership.left' || type='membership.removed')"
	}

	events, err := app.FindRecordsByFilter("conversation_events", filter, "cursor", limit, 0, params)
	if err != nil {
		return nil, cursor, false, err
	}
	if len(events) == limit {
		return events, events[len(events)-1].GetInt("cursor"), true, nil
	}
	latestCursor, err := latestConversationEventCursor(app)
	if err != nil {
		return nil, cursor, false, err
	}

	return events, latestCursor, false, nil
}

func findActiveConversationMembership(app core.App, conversationId string, userId string) (*core.Record, *core.Record, error) {
	if strings.TrimSpace(conversationId) == "" {
		return nil, nil, router.NewBadRequestError("Conversation is required.", nil)
	}
	conversation, err := app.FindRecordById("conversations", conversationId)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, router.NewBadRequestError("Conversation was not found.", nil)
		}
		return nil, nil, err
	}
	membership, err := findActiveMembershipByConversation(app, conversation.Id, userId)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil, router.NewForbiddenError("You are not an active member of this conversation.", nil)
		}
		return nil, nil, err
	}

	return conversation, membership, nil
}

func findActiveMembershipByConversation(app core.App, conversationId string, userId string) (*core.Record, error) {
	return app.FindFirstRecordByFilter(
		"conversation_memberships",
		"conversation={:conversation} && user={:user} && status='active'",
		dbx.Params{"conversation": conversationId, "user": userId},
	)
}

func findActiveMembershipsForUser(app core.App, userId string) ([]*core.Record, error) {
	return app.FindRecordsByFilter(
		"conversation_memberships",
		"user={:user} && status='active'",
		"-updated",
		0,
		0,
		dbx.Params{"user": userId},
	)
}

func conversationsForMemberships(app core.App, memberships []*core.Record) ([]*core.Record, error) {
	conversations := make([]*core.Record, 0, len(memberships))
	for _, membership := range memberships {
		conversation, err := app.FindRecordById("conversations", membership.GetString("conversation"))
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return nil, err
		}
		conversations = append(conversations, conversation)
	}

	return conversations, nil
}

func activeMembershipsForConversations(app core.App, conversations []*core.Record) ([]*core.Record, error) {
	memberships := make([]*core.Record, 0)
	for _, conversation := range conversations {
		conversationMemberships, err := app.FindRecordsByFilter(
			"conversation_memberships",
			"conversation={:conversation} && status='active'",
			"user",
			0,
			0,
			dbx.Params{"conversation": conversation.Id},
		)
		if err != nil {
			return nil, err
		}
		memberships = append(memberships, conversationMemberships...)
	}

	return memberships, nil
}

func createMembership(app core.App, conversation *core.Record, userId string, addedBy string, role string, joinSource string, joinedMessageSeq int, historyStartMessageSeq int, liveStartCursor int) error {
	_, err := createMembershipRecord(app, conversation, userId, addedBy, role, joinSource, joinedMessageSeq, historyStartMessageSeq, liveStartCursor)
	return err
}

func createMembershipRecord(app core.App, conversation *core.Record, userId string, addedBy string, role string, joinSource string, joinedMessageSeq int, historyStartMessageSeq int, liveStartCursor int) (*core.Record, error) {
	collection, err := app.FindCollectionByNameOrId("conversation_memberships")
	if err != nil {
		return nil, err
	}
	epochNo, err := nextMembershipEpoch(app, conversation.Id, userId)
	if err != nil {
		return nil, err
	}
	membership := core.NewRecord(collection)
	membership.Set("conversation", conversation.Id)
	membership.Set("user", userId)
	membership.Set("epoch_no", epochNo)
	membership.Set("role", role)
	membership.Set("status", "active")
	membership.Set("join_source", joinSource)
	membership.Set("added_by", addedBy)
	membership.Set("joined_message_seq", joinedMessageSeq)
	membership.Set("history_start_message_seq", historyStartMessageSeq)
	membership.Set("live_start_cursor", liveStartCursor)
	membership.Set("last_read_message_seq", 0)
	membership.Set("notification_level", "all")

	return membership, app.Save(membership)
}

func nextMembershipEpoch(app core.App, conversationId string, userId string) (int, error) {
	memberships, err := app.FindRecordsByFilter(
		"conversation_memberships",
		"conversation={:conversation} && user={:user}",
		"-epoch_no",
		1,
		0,
		dbx.Params{"conversation": conversationId, "user": userId},
	)
	if err != nil {
		return 0, err
	}
	if len(memberships) == 0 {
		return 1, nil
	}

	return memberships[0].GetInt("epoch_no") + 1, nil
}

func endMembership(app core.App, conversation *core.Record, membership *core.Record, actorId string, status string, cursor int) error {
	membership.Set("status", status)
	membership.Set("removed_by", actorId)
	membership.Set("ended_message_seq", conversation.GetInt("last_message_seq"))
	membership.Set("ended_cursor", cursor)
	membership.Set("ended_at", types.NowDateTime())

	return app.Save(membership)
}

func countActiveMemberships(app core.App, conversationId string) int {
	memberships, err := app.FindRecordsByFilter("conversation_memberships", "conversation={:conversation} && status='active'", "", 0, 0, dbx.Params{"conversation": conversationId})
	if err != nil {
		return 0
	}

	return len(memberships)
}

func membershipHistoryStartSeq(conversation *core.Record) int {
	if conversation.GetString("default_history_policy") == "full" {
		return 1
	}

	return conversation.GetInt("last_message_seq") + 1
}

func normalizeHistoryPolicy(value string) string {
	if strings.TrimSpace(value) == "full" {
		return "full"
	}

	return "since_join"
}

func membershipCanManageGroup(membership *core.Record) bool {
	role := membership.GetString("role")
	return role == "owner" || role == "admin"
}

func membershipCanManageMembers(membership *core.Record) bool {
	return membershipCanManageGroup(membership)
}

func membershipCanDeleteAnyMessage(membership *core.Record) bool {
	return membershipCanManageGroup(membership)
}

func createConversationEvent(app core.App, conversation *core.Record, eventType string, actorUserId string, actorMembershipId string, subjectUserId string, subjectMembershipId string, messageId string, cursor int, payload conversationEventPayload) error {
	collection, err := app.FindCollectionByNameOrId("conversation_events")
	if err != nil {
		return err
	}
	eventSeq, err := reserveConversationEventSeq(app, conversation.Id)
	if err != nil {
		return err
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	event := core.NewRecord(collection)
	event.Set("cursor", cursor)
	event.Set("conversation", conversation.Id)
	event.Set("event_seq", eventSeq)
	event.Set("type", eventType)
	event.Set("actor_user", actorUserId)
	event.Set("actor_membership", actorMembershipId)
	event.Set("subject_user", subjectUserId)
	event.Set("subject_membership", subjectMembershipId)
	event.Set("message", messageId)
	event.Set("payload", string(payloadJSON))

	return app.Save(event)
}

func hashIdempotentMessagePayload(conversationId string, kind string, body string) string {
	payload := fmt.Sprintf("%s\x00%s\x00%s", conversationId, kind, body)
	sum := sha256.Sum256([]byte(payload))

	return hex.EncodeToString(sum[:])
}

func reserveMessageSeq(app core.App, conversationId string) (int, error) {
	var messageSeq int
	err := app.DB().NewQuery(
		`UPDATE conversations
         SET next_message_seq = CASE WHEN next_message_seq > 0 THEN next_message_seq + 1 ELSE 2 END
         WHERE id={:conversation}
		 RETURNING next_message_seq - 1`,
	).Bind(dbx.Params{"conversation": conversationId}).Row(&messageSeq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, router.NewBadRequestError("Conversation was not found.", nil)
	}

	return messageSeq, err
}

func reserveConversationEventSeq(app core.App, conversationId string) (int, error) {
	var eventSeq int
	err := app.DB().NewQuery(
		`UPDATE conversations
         SET next_event_seq = CASE WHEN next_event_seq > 0 THEN next_event_seq + 1 ELSE 2 END
         WHERE id={:conversation}
		 RETURNING next_event_seq - 1`,
	).Bind(dbx.Params{"conversation": conversationId}).Row(&eventSeq)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, router.NewBadRequestError("Conversation was not found.", nil)
	}

	return eventSeq, err
}

func nextConversationEventCursor(app core.App) (int, error) {
	for attempt := 0; attempt < 2; attempt++ {
		var cursor int
		err := app.DB().NewQuery(
			`UPDATE event_cursors
			 SET next_cursor = CASE WHEN next_cursor > 0 THEN next_cursor + 1 ELSE 2 END
			 WHERE scope = 'global'
			 RETURNING CASE WHEN next_cursor > 1 THEN next_cursor - 1 ELSE 1 END`,
		).Row(&cursor)
		if err == nil {
			return cursor, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return 0, err
		}
		if err := ensureGlobalEventCursorRecord(app); err != nil {
			return 0, err
		}
	}

	return 0, errors.New("failed to initialize conversation event cursor")
}

func latestConversationEventCursor(app core.App) (int, error) {
	events, err := app.FindRecordsByFilter("conversation_events", "", "-cursor", 1, 0)
	if err != nil {
		return 0, err
	}
	if len(events) == 0 {
		return 0, nil
	}

	return events[0].GetInt("cursor"), nil
}

func ensureGlobalEventCursorRecord(app core.App) error {
	collection, err := app.FindCollectionByNameOrId("event_cursors")
	if err != nil {
		return err
	}
	record := core.NewRecord(collection)
	record.Set("scope", "global")
	record.Set("next_cursor", 1)
	if err := app.Save(record); err != nil {
		if _, existingErr := app.FindFirstRecordByFilter("event_cursors", "scope={:scope}", dbx.Params{"scope": "global"}); existingErr == nil {
			return nil
		}
		return err
	}

	return nil
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
