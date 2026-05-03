package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	_ "infchat/services/pocketbase/internal/migrations"

	livekitauth "github.com/livekit/protocol/auth"
	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/security"
	"github.com/pocketbase/pocketbase/tools/types"
)

const callRingTimeout = 45 * time.Second
const callParticipantStaleTimeout = 45 * time.Second
const callRoomActiveFilter = "status='ringing' || status='active'"
const staleRingingCleanupInterval = 15 * time.Second
const liveKitTokenTTL = 2 * time.Hour

var callCleanupOnce sync.Once

func main() {
	app := pocketbase.New()

	bindAuthHooks(app)
	bindProfileHooks(app)
	bindPrivacyHooks(app)
	bindFriendshipHooks(app)
	bindConversationHooks(app)
	bindCallRoutes(app)
	bindChatSyncRoutes(app)
	bindFriendSuggestionRoutes(app)
	bindPresenceRoutes(app)
	bindPushRoutes(app)

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

type callTokenRequest struct {
	ConversationId string `json:"conversationId" form:"conversationId"`
	DeviceId       string `json:"deviceId" form:"deviceId"`
	Kind           string `json:"kind" form:"kind"`
}

type callJoinRequest struct {
	DeviceId string `json:"deviceId" form:"deviceId"`
}

type liveKitParticipantMetadata struct {
	DeviceId    string `json:"deviceId"`
	DisplayName string `json:"displayName,omitempty"`
	UserId      string `json:"userId"`
	Username    string `json:"username,omitempty"`
}

type friendSuggestionPayload struct {
	MutualFriendCount int            `json:"mutualFriendCount"`
	Profile           map[string]any `json:"profile"`
	Source            string         `json:"source"`
}

func bindFriendSuggestionRoutes(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		group := se.Router.Group("/api/infchat/friends")
		group.Bind(apis.RequireAuth("users"))

		group.GET("/suggestions", func(e *core.RequestEvent) error {
			limit := requestLimit(e, 20, 50)
			suggestions, err := findFriendSuggestions(e.App, e.Auth.Id, limit)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{"suggestions": suggestions})
		})

		return se.Next()
	})
}

func requestLimit(e *core.RequestEvent, fallback int, max int) int {
	limit, err := strconv.Atoi(e.Request.URL.Query().Get("limit"))
	if err != nil || limit <= 0 {
		return fallback
	}
	if limit > max {
		return max
	}

	return limit
}

func findFriendSuggestions(app core.App, userId string, limit int) ([]friendSuggestionPayload, error) {
	activeFriendships, err := app.FindRecordsByFilter(
		"friendships",
		"(requester={:userId} || recipient={:userId}) && (status='accepted' || status='pending')",
		"-updated",
		500,
		0,
		dbx.Params{"userId": userId},
	)
	if err != nil {
		return nil, err
	}

	excludedUserIds := map[string]struct{}{userId: {}}
	friendIds := make([]string, 0, len(activeFriendships))
	for _, friendship := range activeFriendships {
		otherUserId := otherFriendshipUserId(friendship, userId)
		if otherUserId == "" {
			continue
		}

		excludedUserIds[otherUserId] = struct{}{}
		if friendship.GetString("status") == "accepted" {
			friendIds = append(friendIds, otherUserId)
		}
	}

	mutualCounts := map[string]int{}
	for _, friendId := range friendIds {
		friendships, err := app.FindRecordsByFilter(
			"friendships",
			"(requester={:friendId} || recipient={:friendId}) && status='accepted'",
			"-updated",
			500,
			0,
			dbx.Params{"friendId": friendId},
		)
		if err != nil {
			return nil, err
		}

		for _, friendship := range friendships {
			candidateUserId := otherFriendshipUserId(friendship, friendId)
			if candidateUserId == "" {
				continue
			}
			if _, excluded := excludedUserIds[candidateUserId]; excluded {
				continue
			}

			mutualCounts[candidateUserId]++
		}
	}

	candidateUserIds := make([]string, 0, len(mutualCounts))
	for candidateUserId := range mutualCounts {
		candidateUserIds = append(candidateUserIds, candidateUserId)
	}
	sort.Slice(candidateUserIds, func(i int, j int) bool {
		firstCount := mutualCounts[candidateUserIds[i]]
		secondCount := mutualCounts[candidateUserIds[j]]
		if firstCount == secondCount {
			return candidateUserIds[i] < candidateUserIds[j]
		}

		return firstCount > secondCount
	})

	suggestions := make([]friendSuggestionPayload, 0, limit)
	suggestedUserIds := map[string]struct{}{}
	for _, candidateUserId := range candidateUserIds {
		if len(suggestions) >= limit {
			return suggestions, nil
		}
		if !privacySettingBool(app, candidateUserId, "show_in_mutual_suggestions", true) {
			continue
		}

		suggestion, err := friendSuggestionForUser(app, candidateUserId, mutualCounts[candidateUserId], "mutual")
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}

			return nil, err
		}

		suggestions = append(suggestions, suggestion)
		suggestedUserIds[candidateUserId] = struct{}{}
	}

	if len(suggestions) >= limit {
		return suggestions, nil
	}

	publicSettings, err := app.FindRecordsByFilter(
		"privacy_settings",
		"show_in_public_suggestions=true",
		"-updated",
		100,
		0,
	)
	if err != nil {
		return nil, err
	}
	rand.Shuffle(len(publicSettings), func(i int, j int) {
		publicSettings[i], publicSettings[j] = publicSettings[j], publicSettings[i]
	})

	for _, settings := range publicSettings {
		if len(suggestions) >= limit {
			break
		}

		candidateUserId := settings.GetString("user")
		if candidateUserId == "" {
			continue
		}
		if _, excluded := excludedUserIds[candidateUserId]; excluded {
			continue
		}
		if _, suggested := suggestedUserIds[candidateUserId]; suggested {
			continue
		}

		suggestion, err := friendSuggestionForUser(app, candidateUserId, 0, "public")
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}

			return nil, err
		}

		suggestions = append(suggestions, suggestion)
		suggestedUserIds[candidateUserId] = struct{}{}
	}

	return suggestions, nil
}

func otherFriendshipUserId(friendship *core.Record, userId string) string {
	requester := friendship.GetString("requester")
	recipient := friendship.GetString("recipient")
	if requester == userId {
		return recipient
	}
	if recipient == userId {
		return requester
	}

	return ""
}

func privacySettingBool(app core.App, userId string, field string, fallback bool) bool {
	settings, err := app.FindFirstRecordByFilter("privacy_settings", "user={:user}", dbx.Params{"user": userId})
	if err != nil {
		return fallback
	}

	return settings.GetBool(field)
}

func friendSuggestionForUser(app core.App, userId string, mutualFriendCount int, source string) (friendSuggestionPayload, error) {
	profile, err := app.FindFirstRecordByFilter("profiles", "user={:user}", dbx.Params{"user": userId})
	if err != nil {
		return friendSuggestionPayload{}, err
	}

	return friendSuggestionPayload{
		MutualFriendCount: mutualFriendCount,
		Profile:           profilePayload(profile),
		Source:            source,
	}, nil
}

func profilePayload(profile *core.Record) map[string]any {
	return map[string]any{
		"id":                   profile.Id,
		"user":                 profile.GetString("user"),
		"username":             profile.GetString("username"),
		"display_name":         profile.GetString("display_name"),
		"avatar":               profile.GetString("avatar"),
		"bio":                  profile.GetString("bio"),
		"setup_skipped_fields": profile.GetString("setup_skipped_fields"),
		"collectionId":         profile.Collection().Id,
		"collectionName":       profile.Collection().Name,
		"created":              profile.GetString("created"),
		"updated":              profile.GetString("updated"),
	}
}

func bindCallRoutes(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		callCleanupOnce.Do(func() {
			go runCallCleanup(app)
		})

		group := se.Router.Group("/api/infchat/calls")
		group.Bind(apis.RequireAuth("users"))

		group.GET("/active", func(e *core.RequestEvent) error {
			if err := cleanupStaleCalls(e.App); err != nil {
				return err
			}

			memberships, err := findActiveMembershipsForUser(e.App, e.Auth.Id)
			if err != nil {
				return err
			}
			callRooms := make([]*core.Record, 0)
			for _, membership := range memberships {
				rooms, err := e.App.FindRecordsByFilter(
					"call_rooms",
					"conversation={:conversation} && ("+callRoomActiveFilter+")",
					"-created",
					0,
					0,
					dbx.Params{"conversation": membership.GetString("conversation")},
				)
				if err != nil {
					return err
				}
				callRooms = append(callRooms, rooms...)
			}

			sort.Slice(callRooms, func(i, j int) bool {
				return callRooms[i].GetString("created") > callRooms[j].GetString("created")
			})

			return e.JSON(http.StatusOK, map[string]any{"callRooms": callRooms})
		})

		group.POST("/start", func(e *core.RequestEvent) error {
			if err := cleanupStaleCalls(e.App); err != nil {
				return err
			}

			data := callTokenRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read call data.", err)
			}

			conversationId := strings.TrimSpace(data.ConversationId)
			kind := strings.TrimSpace(data.Kind)
			if kind != "voice" && kind != "video" {
				return e.BadRequestError("Call kind must be voice or video.", nil)
			}

			conversation, err := findConversationForCall(e.App, conversationId, e.Auth.Id)
			if err != nil {
				return err
			}

			existingCallRoom, err := e.App.FindFirstRecordByFilter(
				"call_rooms",
				"conversation={:conversationId} && ("+callRoomActiveFilter+")",
				dbx.Params{"conversationId": conversation.Id},
			)
			if err == nil {
				if err := ensureUserCanJoinCall(e.App, e.Auth.Id, existingCallRoom); err != nil {
					return e.BadRequestError("You are already in another call.", err)
				}

				activated, err := joinCallRoom(e.App, existingCallRoom, e.Auth.Id, data.DeviceId)
				if err != nil {
					return err
				}
				if activated {
					go sendCallUpdatePushNotifications(e.App, existingCallRoom, "active", e.Auth.Id, data.DeviceId)
				}

				return respondWithCallToken(e, existingCallRoom, data.DeviceId)
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return err
			}

			if err := ensureUserCanJoinCall(e.App, e.Auth.Id, nil); err != nil {
				return e.BadRequestError("You are already in another call.", err)
			}

			callRoom, err := createStartedCallRoom(e.App, conversation, e.Auth.Id, kind, data.DeviceId)
			if err != nil {
				existingCallRoom, findErr := e.App.FindFirstRecordByFilter(
					"call_rooms",
					"conversation={:conversationId} && ("+callRoomActiveFilter+")",
					dbx.Params{"conversationId": conversation.Id},
				)
				if findErr != nil {
					return err
				}
				if err := ensureUserCanJoinCall(e.App, e.Auth.Id, existingCallRoom); err != nil {
					return e.BadRequestError("You are already in another call.", err)
				}

				activated, err := joinCallRoom(e.App, existingCallRoom, e.Auth.Id, data.DeviceId)
				if err != nil {
					return err
				}
				if activated {
					go sendCallUpdatePushNotifications(e.App, existingCallRoom, "active", e.Auth.Id, data.DeviceId)
				}

				return respondWithCallToken(e, existingCallRoom, data.DeviceId)
			}

			go sendIncomingCallPushNotifications(e.App, callRoom)

			return respondWithCallToken(e, callRoom, data.DeviceId)
		})

		group.POST("/{id}/join", func(e *core.RequestEvent) error {
			if err := cleanupStaleCalls(e.App); err != nil {
				return err
			}

			data := callJoinRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read call data.", err)
			}

			callRoom, err := findCallRoomForUser(e.App, e.Request.PathValue("id"), e.Auth.Id)
			if err != nil {
				return err
			}

			if !isJoinableCallStatus(callRoom.GetString("status")) {
				return e.BadRequestError(callUnavailableMessage(callRoom.GetString("status")), nil)
			}
			if err := ensureUserCanJoinCall(e.App, e.Auth.Id, callRoom); err != nil {
				return e.BadRequestError("You are already in another call.", err)
			}

			activated, err := joinCallRoom(e.App, callRoom, e.Auth.Id, data.DeviceId)
			if err != nil {
				return err
			}
			if activated {
				go sendCallUpdatePushNotifications(e.App, callRoom, "active", e.Auth.Id, data.DeviceId)
			}

			return respondWithCallToken(e, callRoom, data.DeviceId)
		})

		group.POST("/{id}/heartbeat", func(e *core.RequestEvent) error {
			if err := cleanupStaleCalls(e.App); err != nil {
				return err
			}

			data := callJoinRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read call data.", err)
			}

			callRoom, err := findCallRoomForUser(e.App, e.Request.PathValue("id"), e.Auth.Id)
			if err != nil {
				return err
			}

			if !isJoinableCallStatus(callRoom.GetString("status")) {
				return e.BadRequestError(callUnavailableMessage(callRoom.GetString("status")), nil)
			}

			if err := markCallParticipantActive(e.App, callRoom, e.Auth.Id, data.DeviceId); err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{"callRoom": callRoomPayload(callRoom)})
		})

		group.POST("/{id}/leave", func(e *core.RequestEvent) error {
			if err := cleanupStaleCalls(e.App); err != nil {
				return err
			}

			data := callJoinRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read call data.", err)
			}

			callRoom, err := findCallRoomForUser(e.App, e.Request.PathValue("id"), e.Auth.Id)
			if err != nil {
				return err
			}

			if isJoinableCallStatus(callRoom.GetString("status")) {
				if err := markCallParticipantLeft(e.App, callRoom, e.Auth.Id, data.DeviceId); err != nil {
					return err
				}

				if callRoom.GetString("status") == "active" {
					if err := finishCallRoomIfEmpty(e.App, callRoom); err != nil {
						return err
					}
				}
			}

			return e.JSON(http.StatusOK, map[string]any{"callRoom": callRoomPayload(callRoom)})
		})

		group.POST("/{id}/end", func(e *core.RequestEvent) error {
			if err := cleanupStaleCalls(e.App); err != nil {
				return err
			}

			callRoom, err := findCallRoomForUser(e.App, e.Request.PathValue("id"), e.Auth.Id)
			if err != nil {
				return err
			}

			if isJoinableCallStatus(callRoom.GetString("status")) {
				if err := ensureUserCanEndCallForEveryone(e.App, callRoom, e.Auth.Id); err != nil {
					return err
				}
				status := finishedCallStatus(callRoom, e.Auth.Id)
				if err := finishCallRoom(e.App, callRoom, status); err != nil {
					return err
				}
			}

			return e.JSON(http.StatusOK, map[string]any{"callRoom": callRoomPayload(callRoom)})
		})

		return se.Next()
	})
}

func findConversationForCall(app core.App, conversationId string, userId string) (*core.Record, error) {
	conversation, _, err := findActiveConversationMembership(app, conversationId, userId)
	return conversation, err
}

func findCallRoomForUser(app core.App, callRoomId string, userId string) (*core.Record, error) {
	if strings.TrimSpace(callRoomId) == "" {
		return nil, router.NewBadRequestError("Call room is required.", nil)
	}

	callRoom, err := app.FindRecordById("call_rooms", callRoomId)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, router.NewBadRequestError("Call was not found.", nil)
		}

		return nil, err
	}

	if _, err := findConversationForCall(app, callRoom.GetString("conversation"), userId); err != nil {
		return nil, err
	}

	return callRoom, nil
}

func findOpenCallForUser(app core.App, userId string, excludedConversationId string) (*core.Record, error) {
	participant, err := app.FindFirstRecordByFilter(
		"call_participants",
		"user={:userId} && status='active' && call_room.conversation!={:conversationId} && (call_room.status='ringing' || call_room.status='active')",
		dbx.Params{"conversationId": excludedConversationId, "userId": userId},
	)
	if err != nil {
		return nil, err
	}

	return app.FindRecordById("call_rooms", participant.GetString("call_room"))
}

func ensureUserCanJoinCall(app core.App, userId string, callRoom *core.Record) error {
	excludedCallRoomId := ""
	if callRoom != nil {
		excludedCallRoomId = callRoom.Id
	}
	filter := "user={:userId} && status='active' && (call_room.status='ringing' || call_room.status='active')"
	params := dbx.Params{"userId": userId}
	if excludedCallRoomId != "" {
		filter += " && call_room!={:callRoomId}"
		params["callRoomId"] = excludedCallRoomId
	}
	otherParticipant, err := app.FindFirstRecordByFilter("call_participants", filter, params)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}

	return fmt.Errorf("user is already in call %s", otherParticipant.GetString("call_room"))
}

func joinCallRoom(app core.App, callRoom *core.Record, userId string, deviceId string) (bool, error) {
	activated := false
	err := app.RunInTransaction(func(txApp core.App) error {
		currentCallRoom, err := txApp.FindRecordById("call_rooms", callRoom.Id)
		if err != nil {
			return err
		}

		if currentCallRoom.GetString("status") == "ringing" && currentCallRoom.GetString("created_by") != userId {
			currentCallRoom.Set("status", "active")
			if err := txApp.Save(currentCallRoom); err != nil {
				return err
			}
			activated = true
		}

		if err := markCallParticipantActive(txApp, currentCallRoom, userId, deviceId); err != nil {
			return err
		}

		callRoom.Set("status", currentCallRoom.GetString("status"))
		callRoom.Set("ended_at", currentCallRoom.GetString("ended_at"))

		return nil
	})

	return activated, err
}

func ensureUserCanEndCallForEveryone(app core.App, callRoom *core.Record, userId string) error {
	conversation, membership, err := findActiveConversationMembership(app, callRoom.GetString("conversation"), userId)
	if err != nil {
		return err
	}
	if conversation.GetString("kind") == "private" {
		return nil
	}
	if membershipCanManageGroup(membership) {
		return nil
	}

	return router.NewForbiddenError("Only group admins can end this call for everyone.", nil)
}

func respondWithCallToken(e *core.RequestEvent, callRoom *core.Record, deviceId string) error {
	liveKitURL, apiKey, apiSecret, err := liveKitConfig()
	if err != nil {
		return e.InternalServerError("LiveKit is not configured.", err)
	}

	participantName, username := liveKitParticipantName(e.App, e.Auth.Id)
	token, err := createLiveKitToken(apiKey, apiSecret, callRoom.GetString("room_name"), e.Auth.Id, deviceId, participantName, username)
	if err != nil {
		return e.InternalServerError("Could not create call token.", err)
	}

	return e.JSON(http.StatusOK, map[string]any{
		"callRoom":   callRoomPayload(callRoom),
		"livekitUrl": liveKitURL,
		"token":      token,
	})
}

func createLiveKitToken(apiKey string, apiSecret string, roomName string, userId string, deviceId string, displayName string, username string) (string, error) {
	canPublish := true
	canSubscribe := true
	canPublishData := true
	normalizedDeviceId := normalizedDeviceId(deviceId)
	metadata, err := json.Marshal(liveKitParticipantMetadata{
		DeviceId:    normalizedDeviceId,
		DisplayName: displayName,
		UserId:      userId,
		Username:    username,
	})
	if err != nil {
		return "", err
	}

	return livekitauth.NewAccessToken(apiKey, apiSecret).
		SetIdentity(fmt.Sprintf("%s:%s", userId, normalizedDeviceId)).
		SetName(displayName).
		SetMetadata(string(metadata)).
		SetValidFor(liveKitTokenTTL).
		SetVideoGrant(&livekitauth.VideoGrant{
			RoomJoin:       true,
			Room:           roomName,
			CanPublish:     &canPublish,
			CanSubscribe:   &canSubscribe,
			CanPublishData: &canPublishData,
		}).
		ToJWT()
}

func liveKitParticipantName(app core.App, userId string) (string, string) {
	profile, err := app.FindFirstRecordByFilter("profiles", "user={:user}", dbx.Params{"user": userId})
	if err != nil {
		return userId, ""
	}

	displayName := strings.TrimSpace(profile.GetString("display_name"))
	username := strings.TrimSpace(profile.GetString("username"))
	if displayName == "" {
		displayName = username
	}
	if displayName == "" {
		displayName = userId
	}

	return displayName, username
}

func liveKitConfig() (string, string, string, error) {
	liveKitURL := strings.TrimSpace(os.Getenv("LIVEKIT_URL"))
	apiKey := strings.TrimSpace(os.Getenv("LIVEKIT_API_KEY"))
	apiSecret := strings.TrimSpace(os.Getenv("LIVEKIT_API_SECRET"))
	if liveKitURL == "" || apiKey == "" || apiSecret == "" {
		return "", "", "", errors.New("LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required")
	}

	return liveKitURL, apiKey, apiSecret, nil
}

func callRoomPayload(callRoom *core.Record) map[string]any {
	return map[string]any{
		"id":           callRoom.Id,
		"conversation": callRoom.GetString("conversation"),
		"created_by":   callRoom.GetString("created_by"),
		"kind":         callRoom.GetString("kind"),
		"room_name":    callRoom.GetString("room_name"),
		"status":       callRoom.GetString("status"),
		"ended_at":     callRoom.GetString("ended_at"),
		"created":      callRoom.GetString("created"),
		"updated":      callRoom.GetString("updated"),
	}
}

func createStartedCallRoom(app core.App, conversation *core.Record, userId string, kind string, deviceId string) (*core.Record, error) {
	var callRoom *core.Record
	err := app.RunInTransaction(func(txApp core.App) error {
		conversation, membership, err := findActiveConversationMembership(txApp, conversation.Id, userId)
		if err != nil {
			return err
		}
		collection, err := txApp.FindCollectionByNameOrId("call_rooms")
		if err != nil {
			return err
		}

		callRoom = core.NewRecord(collection)
		callRoom.Set("conversation", conversation.Id)
		callRoom.Set("created_by", userId)
		callRoom.Set("created_by_membership", membership.Id)
		callRoom.Set("kind", kind)
		callRoom.Set("room_name", newCallRoomName(conversation.Id))
		callRoom.Set("status", "ringing")
		callRoom.Set("ended_at", "")

		if err := txApp.Save(callRoom); err != nil {
			return err
		}
		cursor, err := nextConversationEventCursor(txApp)
		if err != nil {
			return err
		}
		conversation, message, err := createCallMessage(txApp, callRoom, membership, cursor)
		if err != nil {
			return err
		}
		if err := createConversationEvent(txApp, conversation, "call.started", userId, membership.Id, "", "", message.Id, cursor, conversationEventPayload{Conversation: conversation, Membership: membership, Message: message}); err != nil {
			return err
		}

		return markCallParticipantActive(txApp, callRoom, userId, deviceId)
	})

	return callRoom, err
}

func createCallMessage(app core.App, callRoom *core.Record, membership *core.Record, cursor int) (*core.Record, *core.Record, error) {
	collection, err := app.FindCollectionByNameOrId("messages")
	if err != nil {
		return nil, nil, err
	}
	conversationId := callRoom.GetString("conversation")
	messageSeq, err := reserveMessageSeq(app, conversationId)
	if err != nil {
		return nil, nil, err
	}

	message := core.NewRecord(collection)
	message.Set("conversation", conversationId)
	message.Set("sender", callRoom.GetString("created_by"))
	message.Set("sender_membership", membership.Id)
	message.Set("kind", "call")
	message.Set("body", activeCallMessageBody(callRoom.GetString("kind")))
	message.Set("call_room", callRoom.Id)
	message.Set("message_seq", messageSeq)
	message.Set("edit_version", 0)
	if err := app.Save(message); err != nil {
		return nil, nil, err
	}
	conversation, err := updateConversationPreviewFromMessageWithCursor(app, message, message.GetString("created"), cursor)
	if err != nil {
		return nil, nil, err
	}

	return conversation, message, nil
}

func runCallCleanup(app core.App) {
	if err := cleanupStaleCalls(app); err != nil {
		log.Printf("failed to clean stale calls: %v", err)
	}

	ticker := time.NewTicker(staleRingingCleanupInterval)
	defer ticker.Stop()

	for range ticker.C {
		if err := cleanupStaleCalls(app); err != nil {
			log.Printf("failed to clean stale calls: %v", err)
		}
	}
}

func cleanupStaleCalls(app core.App) error {
	if err := cleanupStaleRingingCalls(app); err != nil {
		return err
	}
	if err := cleanupStaleCallParticipants(app); err != nil {
		return err
	}

	return cleanupEmptyActiveCalls(app)
}

func cleanupStaleRingingCalls(app core.App) error {
	cutoff := types.NowDateTime().Add(-callRingTimeout)
	callRooms, err := app.FindRecordsByFilter(
		"call_rooms",
		"status='ringing' && created <= {:cutoff}",
		"created",
		50,
		0,
		dbx.Params{"cutoff": cutoff},
	)
	if err != nil {
		return err
	}

	for _, callRoom := range callRooms {
		if err := finishCallRoom(app, callRoom, "missed"); err != nil {
			return err
		}
	}

	return nil
}

func cleanupStaleCallParticipants(app core.App) error {
	cutoff := types.NowDateTime().Add(-callParticipantStaleTimeout)
	participants, err := app.FindRecordsByFilter(
		"call_participants",
		"status='active' && last_seen_at <= {:cutoff}",
		"last_seen_at",
		100,
		0,
		dbx.Params{"cutoff": cutoff},
	)
	if err != nil {
		return err
	}

	now := types.NowDateTime()
	for _, participant := range participants {
		participant.Set("status", "left")
		participant.Set("left_at", now)
		if err := app.Save(participant); err != nil {
			return err
		}
	}

	return nil
}

func cleanupEmptyActiveCalls(app core.App) error {
	callRooms, err := app.FindRecordsByFilter("call_rooms", "status='active'", "created", 100, 0)
	if err != nil {
		return err
	}

	for _, callRoom := range callRooms {
		if err := finishCallRoomIfEmpty(app, callRoom); err != nil {
			return err
		}
	}

	return nil
}

func finishCallRoomIfEmpty(app core.App, callRoom *core.Record) error {
	hasParticipants, err := hasActiveCallParticipants(app, callRoom.Id)
	if err != nil {
		return err
	}
	if hasParticipants {
		return nil
	}

	return finishCallRoom(app, callRoom, "ended")
}

func hasActiveCallParticipants(app core.App, callRoomId string) (bool, error) {
	participants, err := app.FindRecordsByFilter(
		"call_participants",
		"call_room={:callRoomId} && status='active'",
		"",
		1,
		0,
		dbx.Params{"callRoomId": callRoomId},
	)
	if err != nil {
		return false, err
	}

	return len(participants) > 0, nil
}

func markCallParticipantActive(app core.App, callRoom *core.Record, userId string, deviceId string) error {
	deviceId = normalizedDeviceId(deviceId)
	now := types.NowDateTime()
	_, membership, err := findActiveConversationMembership(app, callRoom.GetString("conversation"), userId)
	if err != nil {
		return err
	}
	participant, err := findCallParticipant(app, callRoom.Id, userId, deviceId)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		collection, err := app.FindCollectionByNameOrId("call_participants")
		if err != nil {
			return err
		}

		participant = core.NewRecord(collection)
		participant.Set("call_room", callRoom.Id)
		participant.Set("user", userId)
		participant.Set("membership", membership.Id)
		participant.Set("device_id", deviceId)
		participant.Set("joined_at", now)
	}

	participant.Set("status", "active")
	participant.Set("left_at", "")
	participant.Set("last_seen_at", now)

	return app.Save(participant)
}

func markCallParticipantLeft(app core.App, callRoom *core.Record, userId string, deviceId string) error {
	participant, err := findCallParticipant(app, callRoom.Id, userId, normalizedDeviceId(deviceId))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}

		return err
	}

	now := types.NowDateTime()
	participant.Set("status", "left")
	participant.Set("left_at", now)
	participant.Set("last_seen_at", now)

	return app.Save(participant)
}

func markActiveCallParticipantsLeft(app core.App, callRoomId string) error {
	participants, err := app.FindRecordsByFilter(
		"call_participants",
		"call_room={:callRoomId} && status='active'",
		"",
		0,
		0,
		dbx.Params{"callRoomId": callRoomId},
	)
	if err != nil {
		return err
	}

	now := types.NowDateTime()
	for _, participant := range participants {
		participant.Set("status", "left")
		participant.Set("left_at", now)
		participant.Set("last_seen_at", now)
		if err := app.Save(participant); err != nil {
			return err
		}
	}

	return nil
}

func findCallParticipant(app core.App, callRoomId string, userId string, deviceId string) (*core.Record, error) {
	return app.FindFirstRecordByFilter(
		"call_participants",
		"call_room={:callRoomId} && user={:userId} && device_id={:deviceId}",
		dbx.Params{"callRoomId": callRoomId, "deviceId": deviceId, "userId": userId},
	)
}

func finishCallRoom(app core.App, callRoom *core.Record, status string) error {
	if !isTerminalCallStatus(status) {
		return errors.New("call status must be terminal")
	}

	finished := false
	err := app.RunInTransaction(func(txApp core.App) error {
		currentCallRoom, err := txApp.FindRecordById("call_rooms", callRoom.Id)
		if err != nil {
			return err
		}
		if isTerminalCallStatus(currentCallRoom.GetString("status")) {
			callRoom.Set("status", currentCallRoom.GetString("status"))
			callRoom.Set("ended_at", currentCallRoom.GetString("ended_at"))

			return nil
		}

		currentCallRoom.Set("status", status)
		currentCallRoom.Set("ended_at", types.NowDateTime())
		if err := txApp.Save(currentCallRoom); err != nil {
			return err
		}
		if err := markActiveCallParticipantsLeft(txApp, currentCallRoom.Id); err != nil {
			return err
		}
		message, err := updateCallMessageForEndedCall(txApp, currentCallRoom, status)
		if err != nil {
			return err
		}
		conversation, err := txApp.FindRecordById("conversations", currentCallRoom.GetString("conversation"))
		if err != nil {
			return err
		}
		if message != nil && conversation.GetString("last_message_id") == message.Id {
			conversation.Set("last_message_text", getMessagePreview(txApp, message))
			conversation.Set("last_message_at", message.GetString("updated"))
		}
		cursor, err := nextConversationEventCursor(txApp)
		if err != nil {
			return err
		}
		conversation.Set("latest_event_cursor", cursor)
		if err := txApp.Save(conversation); err != nil {
			return err
		}
		messageId := ""
		if message != nil {
			messageId = message.Id
		}
		if err := createConversationEvent(txApp, conversation, "call.ended", currentCallRoom.GetString("created_by"), currentCallRoom.GetString("created_by_membership"), "", "", messageId, cursor, conversationEventPayload{Conversation: conversation, Message: message}); err != nil {
			return err
		}

		callRoom.Set("status", currentCallRoom.GetString("status"))
		callRoom.Set("ended_at", currentCallRoom.GetString("ended_at"))
		finished = true

		return nil
	})
	if err != nil {
		return err
	}

	if finished {
		go sendCallUpdatePushNotifications(app, callRoom, status, "", "")
	}

	return nil
}

func updateCallMessageForEndedCall(app core.App, callRoom *core.Record, status string) (*core.Record, error) {
	message, err := app.FindFirstRecordByFilter(
		"messages",
		"call_room={:callRoomId}",
		dbx.Params{"callRoomId": callRoom.Id},
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}

		return nil, err
	}

	message.Set("body", callMessageBody(callRoom, status))

	return message, app.Save(message)
}

func finishedCallStatus(callRoom *core.Record, userId string) string {
	if callRoom.GetString("status") != "ringing" {
		return "ended"
	}

	if callRoom.GetString("created_by") == userId {
		return "canceled"
	}

	return "declined"
}

func isJoinableCallStatus(status string) bool {
	return status == "ringing" || status == "active"
}

func isTerminalCallStatus(status string) bool {
	return status == "ended" || status == "missed" || status == "declined" || status == "canceled"
}

func callUnavailableMessage(status string) string {
	switch status {
	case "missed":
		return "This call was missed."
	case "declined":
		return "This call was declined."
	case "canceled":
		return "This call was canceled."
	default:
		return "This call has ended."
	}
}

func callMessageBody(callRoom *core.Record, status string) string {
	label := "Voice call"
	if callRoom.GetString("kind") == "video" {
		label = "Video call"
	}

	switch status {
	case "missed":
		return "Missed " + strings.ToLower(label)
	case "declined":
		return "Declined " + strings.ToLower(label)
	case "canceled":
		return "Canceled " + strings.ToLower(label)
	default:
		return label + " · " + formatCallDuration(callRoom)
	}
}

func formatCallDuration(callRoom *core.Record) string {
	startedAt := callRoom.GetDateTime("created")
	endedAt := callRoom.GetDateTime("ended_at")
	if startedAt.IsZero() || endedAt.IsZero() || endedAt.Before(startedAt) {
		return "00:00"
	}

	duration := endedAt.Sub(startedAt).Round(time.Second)
	minutes := int(duration.Minutes())
	seconds := int(duration.Seconds()) % 60
	if minutes >= 60 {
		hours := minutes / 60
		minutes = minutes % 60
		return fmt.Sprintf("%d:%02d:%02d", hours, minutes, seconds)
	}

	return fmt.Sprintf("%02d:%02d", minutes, seconds)
}

func activeCallMessageBody(kind string) string {
	if kind == "video" {
		return "Video call started"
	}

	return "Voice call started"
}

func newCallRoomName(conversationId string) string {
	return fmt.Sprintf("infchat-%s-%s", conversationId, security.RandomString(18))
}

func normalizedDeviceId(deviceId string) string {
	deviceId = strings.TrimSpace(deviceId)
	if deviceId == "" {
		return "unknown"
	}

	return deviceId
}

func bindConversationHooks(app *pocketbase.PocketBase) {
	app.OnRecordCreateRequest("conversations").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}

		return router.NewBadRequestError("Use the InfChat conversation command endpoints.", nil)
	})

	app.OnRecordCreateRequest("messages").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}

		return router.NewBadRequestError("Use the InfChat message command endpoint.", nil)
	})

	for _, collectionName := range []string{"message_attachments", "attachment_variants", "media_upload_sessions", "media_upload_parts"} {
		app.OnRecordCreateRequest(collectionName).BindFunc(func(e *core.RecordRequestEvent) error {
			if e.HasSuperuserAuth() {
				return e.Next()
			}

			return router.NewBadRequestError("Use the InfChat media command endpoints.", nil)
		})
		app.OnRecordUpdateRequest(collectionName).BindFunc(func(e *core.RecordRequestEvent) error {
			if e.HasSuperuserAuth() {
				return e.Next()
			}

			return router.NewBadRequestError("Use the InfChat media command endpoints.", nil)
		})
		app.OnRecordDeleteRequest(collectionName).BindFunc(func(e *core.RecordRequestEvent) error {
			if e.HasSuperuserAuth() {
				return e.Next()
			}

			return router.NewBadRequestError("Use the InfChat media command endpoints.", nil)
		})
	}
}

func updateConversationPreviewFromMessage(app core.App, message *core.Record, timestamp string) error {
	_, err := updateConversationPreviewFromMessageWithCursor(app, message, timestamp, 0)

	return err
}

func updateConversationPreviewFromMessageWithCursor(app core.App, message *core.Record, timestamp string, cursor int) (*core.Record, error) {
	conversation, err := app.FindRecordById("conversations", message.GetString("conversation"))
	if err != nil {
		return nil, err
	}

	messageSeq := message.GetInt("message_seq")
	if messageSeq > 0 && messageSeq >= conversation.GetInt("last_message_seq") {
		conversation.Set("last_message_id", message.Id)
		conversation.Set("last_message_seq", messageSeq)
		conversation.Set("last_message_text", getMessagePreview(app, message))
		conversation.Set("last_message_at", timestamp)
	}
	if nextSeq := conversation.GetInt("next_message_seq"); messageSeq > 0 && nextSeq <= messageSeq {
		conversation.Set("next_message_seq", messageSeq+1)
	}
	if cursor > 0 {
		conversation.Set("latest_event_cursor", cursor)
	}

	return conversation, app.Save(conversation)
}

func updateConversationPreviewAfterMessageDelete(app core.App, conversation *core.Record, deletedMessage *core.Record) (*core.Record, error) {
	if conversation.GetString("last_message_id") != deletedMessage.Id {
		return conversation, nil
	}

	messages, err := app.FindRecordsByFilter(
		"messages",
		"conversation={:conversation} && deleted_at=''",
		"-message_seq",
		1,
		0,
		dbx.Params{"conversation": conversation.Id},
	)
	if err != nil {
		return nil, err
	}

	if len(messages) == 0 {
		conversation.Set("last_message_id", "")
		conversation.Set("last_message_seq", 0)
		conversation.Set("last_message_text", "")
		conversation.Set("last_message_at", "")

		return conversation, nil
	}

	message := messages[0]
	conversation.Set("last_message_id", message.Id)
	conversation.Set("last_message_seq", message.GetInt("message_seq"))
	conversation.Set("last_message_text", getMessagePreview(app, message))
	conversation.Set("last_message_at", message.GetString("created"))

	return conversation, nil
}

func getMessagePreview(app core.App, record *core.Record) string {
	body := strings.TrimSpace(record.GetString("body"))
	if body != "" {
		return body
	}

	switch record.GetString("kind") {
	case "media":
		return mediaMessagePreview(app, record)
	case "file":
		if attachmentName := firstMessageAttachmentName(app, record); attachmentName != "" {
			return attachmentName
		}

		return "File"
	case "voice":
		return "Voice message"
	default:
		return "Message"
	}
}

func mediaMessagePreview(app core.App, record *core.Record) string {
	attachments, err := app.FindRecordsByFilter(
		"message_attachments",
		"message={:message}",
		"ordinal",
		mediaUploadMaxAttachmentCount,
		0,
		dbx.Params{"message": record.Id},
	)
	if err != nil || len(attachments) == 0 {
		legacyAttachments := record.GetStringSlice("attachments")
		if len(legacyAttachments) == 1 {
			return "Photo"
		}
		if len(legacyAttachments) > 1 {
			return fmt.Sprintf("%d photos", len(legacyAttachments))
		}

		return "Media"
	}

	imageCount := 0
	videoCount := 0
	for _, attachment := range attachments {
		switch attachment.GetString("kind") {
		case "image":
			imageCount++
		case "video":
			videoCount++
		}
	}
	if len(attachments) == 1 {
		if videoCount == 1 {
			return "Video"
		}

		return "Photo"
	}
	if videoCount == 0 {
		return fmt.Sprintf("%d photos", imageCount)
	}
	if imageCount == 0 {
		return fmt.Sprintf("%d videos", videoCount)
	}

	return fmt.Sprintf("%d media", imageCount+videoCount)
}

func firstMessageAttachmentName(app core.App, record *core.Record) string {
	attachments, err := app.FindRecordsByFilter(
		"message_attachments",
		"message={:message}",
		"ordinal",
		1,
		0,
		dbx.Params{"message": record.Id},
	)
	if err == nil && len(attachments) > 0 {
		return strings.TrimSpace(attachments[0].GetString("original_name"))
	}
	legacyAttachments := record.GetStringSlice("attachments")
	if len(legacyAttachments) > 0 {
		return formatStoredAttachmentName(legacyAttachments[0])
	}

	return ""
}

func formatStoredAttachmentName(name string) string {
	base := name
	ext := ""
	if dot := strings.LastIndex(base, "."); dot > 0 {
		ext = base[dot:]
		base = base[:dot]
	}

	if underscore := strings.LastIndex(base, "_"); underscore >= 0 {
		suffix := base[underscore+1:]
		if len(suffix) == 10 && isAlphaNumeric(suffix) {
			base = base[:underscore]
		}
	}

	if strings.TrimSpace(base) == "" {
		return name
	}

	return base + ext
}

func isAlphaNumeric(value string) bool {
	for _, char := range value {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') {
			return false
		}
	}

	return value != ""
}

func bindProfileHooks(app *pocketbase.PocketBase) {
	app.OnRecordAfterCreateSuccess("users").BindFunc(func(e *core.RecordEvent) error {
		if err := ensureProfile(e.App, e.Record); err != nil {
			return err
		}

		return e.Next()
	})

	app.OnRecordAfterUpdateSuccess("users").BindFunc(func(e *core.RecordEvent) error {
		username := normalizeUsernameValue(e.Record.GetString("username"))
		oldUsername := normalizeUsernameValue(e.Record.Original().GetString("username"))
		if username == "" || username == oldUsername {
			return e.Next()
		}

		profile, err := e.App.FindFirstRecordByFilter("profiles", "user={:user}", dbx.Params{"user": e.Record.Id})
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				if err := ensureProfile(e.App, e.Record); err != nil {
					return err
				}

				return e.Next()
			}

			return err
		}

		profile.Set("username", username)
		displayName := strings.TrimSpace(profile.GetString("display_name"))
		if displayName == "" || displayName == oldUsername {
			profile.Set("display_name", username)
		}

		if err := e.App.Save(profile); err != nil {
			return err
		}

		return e.Next()
	})

	app.OnRecordUpdateRequest("profiles").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			if strings.TrimSpace(e.Record.GetString("display_name")) == "" {
				e.Record.Set("display_name", e.Record.GetString("username"))
			}

			return e.Next()
		}

		if e.Auth == nil || e.Record.GetString("user") != e.Auth.Id {
			return router.NewForbiddenError("You can only update your own profile.", nil)
		}

		// Username is owned by the auth record; profile updates can only change public profile fields.
		e.Record.Set("user", e.Record.Original().GetString("user"))
		e.Record.Set("username", e.Record.Original().GetString("username"))
		if strings.TrimSpace(e.Record.GetString("display_name")) == "" {
			e.Record.Set("display_name", e.Record.Original().GetString("username"))
		}

		return e.Next()
	})
}

func bindPrivacyHooks(app *pocketbase.PocketBase) {
	app.OnRecordAfterCreateSuccess("users").BindFunc(func(e *core.RecordEvent) error {
		if err := ensurePrivacySettings(e.App, e.Record.Id); err != nil {
			return err
		}

		return e.Next()
	})

	app.OnRecordUpdateRequest("privacy_settings").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}

		if e.Auth == nil || e.Record.GetString("user") != e.Auth.Id {
			return router.NewForbiddenError("You can only update your own privacy settings.", nil)
		}

		e.Record.Set("user", e.Record.Original().GetString("user"))

		return e.Next()
	})
}

func bindFriendshipHooks(app *pocketbase.PocketBase) {
	app.OnRecordCreateRequest("friendships").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			prepareSuperuserFriendshipRecord(e.Record)
			return e.Next()
		}

		if e.Auth == nil {
			return router.NewForbiddenError("Sign in to add friends.", nil)
		}

		requester := e.Auth.Id
		recipient := e.Record.GetString("recipient")
		if recipient == "" {
			return router.NewBadRequestError("Recipient is required.", nil)
		}
		if requester == recipient {
			return router.NewBadRequestError("You cannot add yourself.", nil)
		}
		if _, err := e.App.FindRecordById("users", recipient); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return router.NewBadRequestError("Recipient was not found.", nil)
			}

			return err
		}

		pairKey := friendshipPairKey(requester, recipient)
		_, err := e.App.FindFirstRecordByFilter(
			"friendships",
			"pair_key={:pairKey} && (status='pending' || status='accepted')",
			dbx.Params{"pairKey": pairKey},
		)
		if err == nil {
			return router.NewBadRequestError("A friendship already exists for these users.", nil)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		e.Record.Set("requester", requester)
		e.Record.Set("recipient", recipient)
		e.Record.Set("pair_key", pairKey)
		e.Record.Set("status", "pending")
		e.Record.Set("accepted_at", "")

		return e.Next()
	})

	app.OnRecordUpdateRequest("friendships").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			prepareSuperuserFriendshipRecord(e.Record)
			return e.Next()
		}

		if e.Auth == nil {
			return router.NewForbiddenError("Sign in to update friend requests.", nil)
		}

		original := e.Record.Original()
		requester := original.GetString("requester")
		recipient := original.GetString("recipient")
		oldStatus := original.GetString("status")
		newStatus := e.Record.GetString("status")

		e.Record.Set("requester", requester)
		e.Record.Set("recipient", recipient)
		e.Record.Set("pair_key", original.GetString("pair_key"))

		if oldStatus != "pending" {
			if newStatus != oldStatus {
				return router.NewBadRequestError("Only pending requests can be changed.", nil)
			}
			return e.Next()
		}

		switch newStatus {
		case "accepted":
			if e.Auth.Id != recipient {
				return router.NewForbiddenError("Only the recipient can accept a request.", nil)
			}
			e.Record.Set("accepted_at", types.NowDateTime())
		case "declined":
			if e.Auth.Id != recipient {
				return router.NewForbiddenError("Only the recipient can decline a request.", nil)
			}
			e.Record.Set("accepted_at", "")
		case "canceled":
			if e.Auth.Id != requester {
				return router.NewForbiddenError("Only the requester can cancel a request.", nil)
			}
			e.Record.Set("accepted_at", "")
		case "pending":
			// Allow harmless metadata updates while preserving immutable fields.
		default:
			return router.NewBadRequestError("Invalid friendship status.", nil)
		}

		return e.Next()
	})
}

func prepareSuperuserFriendshipRecord(record *core.Record) {
	requester := record.GetString("requester")
	recipient := record.GetString("recipient")
	if requester != "" && recipient != "" {
		record.Set("pair_key", friendshipPairKey(requester, recipient))
	}

	if record.GetString("status") == "" {
		record.Set("status", "pending")
	}
	if record.GetString("status") == "accepted" && record.GetString("accepted_at") == "" {
		record.Set("accepted_at", types.NowDateTime())
	}
}

func bindAuthHooks(app *pocketbase.PocketBase) {
	app.OnRecordCreateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		normalizeUsername(e.Record)
		return e.Next()
	})

	app.OnRecordUpdateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		normalizeUsername(e.Record)
		return e.Next()
	})
}

func normalizeUsername(record *core.Record) {
	record.Set("username", normalizeUsernameValue(record.GetString("username")))
}

func normalizeUsernameValue(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

func ensureAcceptedFriendship(app core.App, firstUserId string, secondUserId string) error {
	_, err := app.FindFirstRecordByFilter(
		"friendships",
		"pair_key={:pairKey} && status='accepted'",
		dbx.Params{"pairKey": friendshipPairKey(firstUserId, secondUserId)},
	)
	if err == nil {
		return nil
	}

	if errors.Is(err, sql.ErrNoRows) {
		return router.NewForbiddenError("You can only chat with accepted friends.", nil)
	}

	return err
}

func ensureProfile(app core.App, user *core.Record) error {
	profiles, err := app.FindCollectionByNameOrId("profiles")
	if err != nil {
		return err
	}

	username := normalizeUsernameValue(user.GetString("username"))
	if username == "" {
		return nil
	}

	profile, err := app.FindFirstRecordByFilter("profiles", "user={:user}", dbx.Params{"user": user.Id})
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		profile = core.NewRecord(profiles)
		profile.Set("user", user.Id)
	}

	profile.Set("username", username)
	if strings.TrimSpace(profile.GetString("display_name")) == "" {
		profile.Set("display_name", username)
	}

	return app.Save(profile)
}

func ensurePrivacySettings(app core.App, userId string) error {
	if userId == "" {
		return nil
	}

	_, err := app.FindFirstRecordByFilter("privacy_settings", "user={:user}", dbx.Params{"user": userId})
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	privacySettings, err := app.FindCollectionByNameOrId("privacy_settings")
	if err != nil {
		return err
	}

	settings := core.NewRecord(privacySettings)
	settings.Set("user", userId)
	settings.Set("show_in_public_suggestions", false)
	settings.Set("show_in_mutual_suggestions", true)
	settings.Set("presence_visibility", "contacts_and_shared_chats")

	return app.Save(settings)
}

func friendshipPairKey(firstUserId string, secondUserId string) string {
	ids := []string{firstUserId, secondUserId}
	sort.Strings(ids)
	return strings.Join(ids, ":")
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}

	return false
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	unique := make([]string, 0, len(values))

	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}

		seen[value] = struct{}{}
		unique = append(unique, value)
	}

	return unique
}

func sortedStrings(values []string) []string {
	clone := append([]string(nil), values...)
	sort.Strings(clone)
	return clone
}
