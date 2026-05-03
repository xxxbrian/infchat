package main

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

const presenceOnlineWindow = 45 * time.Second
const presenceExposureTTL = 30 * time.Second

type presenceHeartbeatRequest struct {
	DeviceId string `json:"deviceId" form:"deviceId"`
}

type presenceQueryRequest struct {
	UserIds []string `json:"userIds" form:"userIds"`
}

type presenceRecordPayload struct {
	ApproximateLabel string `json:"approximateLabel,omitempty"`
	IsExact          bool   `json:"isExact"`
	IsOnline         bool   `json:"isOnline"`
	LastSeenAt       string `json:"lastSeenAt,omitempty"`
	UserId           string `json:"userId"`
}

func bindPresenceRoutes(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		group := se.Router.Group("/api/infchat/presence")
		group.Bind(apis.RequireAuth("users"))

		group.POST("/heartbeat", func(e *core.RequestEvent) error {
			data := presenceHeartbeatRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read presence heartbeat.", err)
			}
			session, err := upsertPresenceSession(e.App, e.Auth.Id, data.DeviceId, time.Now().UTC(), false)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{"session": session})
		})

		group.POST("/offline", func(e *core.RequestEvent) error {
			data := presenceHeartbeatRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read presence offline event.", err)
			}
			session, err := upsertPresenceSession(e.App, e.Auth.Id, data.DeviceId, time.Now().UTC(), true)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{"session": session})
		})

		group.POST("/query", func(e *core.RequestEvent) error {
			data := presenceQueryRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read presence query.", err)
			}
			presence, err := queryPresence(e.App, e.Auth.Id, data.UserIds)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{"presence": presence})
		})

		return se.Next()
	})
}

func upsertPresenceSession(app core.App, userId string, deviceId string, now time.Time, isOffline bool) (*core.Record, error) {
	deviceId = strings.TrimSpace(deviceId)
	if deviceId == "" {
		return nil, apis.NewBadRequestError("Presence device id is required.", nil)
	}

	session, err := app.FindFirstRecordByFilter(
		"presence_sessions",
		"user={:userId} && device_id={:deviceId}",
		dbx.Params{"deviceId": deviceId, "userId": userId},
	)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		collection, err := app.FindCollectionByNameOrId("presence_sessions")
		if err != nil {
			return nil, err
		}
		session = core.NewRecord(collection)
		session.Set("user", userId)
		session.Set("device_id", deviceId)
	}

	session.Set("last_seen_at", now)
	if isOffline {
		session.Set("ended_at", now)
	} else {
		session.Set("ended_at", "")
	}

	if err := app.Save(session); err != nil {
		return nil, err
	}

	return session, nil
}

func queryPresence(app core.App, viewerId string, userIds []string) ([]presenceRecordPayload, error) {
	uniqueUserIds := uniqueNonEmptyStrings(userIds)
	if len(uniqueUserIds) == 0 {
		return []presenceRecordPayload{}, nil
	}

	now := time.Now().UTC()
	results := make([]presenceRecordPayload, 0, len(uniqueUserIds))
	for _, userId := range uniqueUserIds {
		lastSeenAt, isOnline, err := latestPresenceForUser(app, userId, now)
		if err != nil {
			return nil, err
		}

		isExact, err := canViewExactPresence(app, viewerId, userId, now)
		if err != nil {
			return nil, err
		}

		payload := presenceRecordPayload{
			IsExact:  isExact,
			IsOnline: isExact && isOnline,
			UserId:   userId,
		}
		if !lastSeenAt.IsZero() {
			if isExact {
				payload.LastSeenAt = lastSeenAt.Format(time.RFC3339)
			} else {
				payload.ApproximateLabel = approximatePresenceLabel(lastSeenAt, now)
			}
		} else if !isExact {
			payload.ApproximateLabel = "last seen a long time ago"
		}

		results = append(results, payload)
	}

	return results, nil
}

func latestPresenceForUser(app core.App, userId string, now time.Time) (time.Time, bool, error) {
	sessions, err := app.FindRecordsByFilter(
		"presence_sessions",
		"user={:userId}",
		"-last_seen_at",
		20,
		0,
		dbx.Params{"userId": userId},
	)
	if err != nil {
		return time.Time{}, false, err
	}

	var latest time.Time
	isOnline := false
	for _, session := range sessions {
		lastSeenAt := session.GetDateTime("last_seen_at").Time()
		if lastSeenAt.IsZero() {
			continue
		}
		if latest.IsZero() || lastSeenAt.After(latest) {
			latest = lastSeenAt
		}
		endedAt := session.GetDateTime("ended_at").Time()
		if endedAt.IsZero() && now.Sub(lastSeenAt) <= presenceOnlineWindow {
			isOnline = true
		}
	}

	return latest, isOnline, nil
}

func canViewExactPresence(app core.App, viewerId string, subjectId string, now time.Time) (bool, error) {
	if viewerId == "" || subjectId == "" {
		return false, nil
	}
	if viewerId == subjectId {
		return true, nil
	}
	if hasPresenceExposure(app, viewerId, subjectId, now) {
		return true, nil
	}

	viewerVisibility := presenceVisibility(app, viewerId)
	subjectVisibility := presenceVisibility(app, subjectId)
	if viewerVisibility == "nobody" || subjectVisibility == "nobody" {
		return false, nil
	}
	if viewerVisibility == "everybody" && subjectVisibility == "everybody" {
		return true, nil
	}

	if viewerVisibility == "contacts_and_shared_chats" || subjectVisibility == "contacts_and_shared_chats" {
		related, err := usersArePresenceContacts(app, viewerId, subjectId)
		if err != nil {
			return false, err
		}

		return related, nil
	}

	return true, nil
}

func presenceVisibility(app core.App, userId string) string {
	settings, err := app.FindFirstRecordByFilter("privacy_settings", "user={:user}", dbx.Params{"user": userId})
	if err != nil {
		return "contacts_and_shared_chats"
	}
	visibility := strings.TrimSpace(settings.GetString("presence_visibility"))
	if visibility == "everybody" || visibility == "contacts_and_shared_chats" || visibility == "nobody" {
		return visibility
	}

	return "contacts_and_shared_chats"
}

func usersArePresenceContacts(app core.App, firstUserId string, secondUserId string) (bool, error) {
	if _, err := app.FindFirstRecordByFilter(
		"friendships",
		"pair_key={:pairKey} && status='accepted'",
		dbx.Params{"pairKey": friendshipPairKey(firstUserId, secondUserId)},
	); err == nil {
		return true, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}

	firstMemberships, err := app.FindRecordsByFilter(
		"conversation_memberships",
		"user={:userId} && status='active'",
		"conversation",
		200,
		0,
		dbx.Params{"userId": firstUserId},
	)
	if err != nil {
		return false, err
	}
	for _, membership := range firstMemberships {
		if _, err := app.FindFirstRecordByFilter(
			"conversation_memberships",
			"conversation={:conversationId} && user={:userId} && status='active'",
			dbx.Params{"conversationId": membership.GetString("conversation"), "userId": secondUserId},
		); err == nil {
			return true, nil
		} else if !errors.Is(err, sql.ErrNoRows) {
			return false, err
		}
	}

	return false, nil
}

func hasPresenceExposure(app core.App, viewerId string, subjectId string, now time.Time) bool {
	exposure, err := app.FindFirstRecordByFilter(
		"presence_exposures",
		"viewer={:viewerId} && subject={:subjectId} && expires_at>{:now}",
		dbx.Params{"now": now.Format(time.RFC3339), "subjectId": subjectId, "viewerId": viewerId},
	)

	return err == nil && exposure != nil
}

func grantPresenceExposure(app core.App, viewerId string, subjectId string) error {
	if viewerId == "" || subjectId == "" || viewerId == subjectId {
		return nil
	}
	now := time.Now().UTC()
	expiresAt := now.Add(presenceExposureTTL)
	exposure, err := app.FindFirstRecordByFilter(
		"presence_exposures",
		"viewer={:viewerId} && subject={:subjectId}",
		dbx.Params{"subjectId": subjectId, "viewerId": viewerId},
	)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		collection, err := app.FindCollectionByNameOrId("presence_exposures")
		if err != nil {
			return err
		}
		exposure = core.NewRecord(collection)
		exposure.Set("viewer", viewerId)
		exposure.Set("subject", subjectId)
	}

	exposure.Set("expires_at", expiresAt)

	return app.Save(exposure)
}

func approximatePresenceLabel(lastSeenAt time.Time, now time.Time) string {
	if lastSeenAt.IsZero() {
		return "last seen a long time ago"
	}
	age := now.Sub(lastSeenAt)
	if age < 0 {
		age = 0
	}
	if age <= 3*24*time.Hour {
		return "last seen recently"
	}
	if age <= 7*24*time.Hour {
		return "last seen within a week"
	}
	if age <= 30*24*time.Hour {
		return "last seen within a month"
	}

	return "last seen a long time ago"
}

func uniqueNonEmptyStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}

	return result
}
