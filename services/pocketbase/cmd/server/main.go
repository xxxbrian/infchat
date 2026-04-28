package main

import (
	"database/sql"
	"errors"
	"log"
	"sort"
	"strings"

	_ "infchat/services/pocketbase/internal/migrations"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
	"github.com/pocketbase/pocketbase/tools/types"
)

func main() {
	app := pocketbase.New()

	bindAuthHooks(app)
	bindProfileHooks(app)
	bindFriendshipHooks(app)
	bindConversationHooks(app)

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}

func bindConversationHooks(app *pocketbase.PocketBase) {
	app.OnRecordCreateRequest("conversations").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			prepareConversationRecord(e.Record)
			return e.Next()
		}

		if e.Auth == nil {
			return router.NewForbiddenError("Sign in to start a chat.", nil)
		}

		members := uniqueStrings(e.Record.GetStringSlice("members"))
		if !containsString(members, e.Auth.Id) {
			members = append(members, e.Auth.Id)
		}

		if len(members) != 2 {
			return router.NewBadRequestError("Private chats require exactly two members.", nil)
		}

		otherUserId := members[0]
		if otherUserId == e.Auth.Id {
			otherUserId = members[1]
		}

		if err := ensureAcceptedFriendship(e.App, e.Auth.Id, otherUserId); err != nil {
			return err
		}

		pairKey := friendshipPairKey(e.Auth.Id, otherUserId)
		_, err := e.App.FindFirstRecordByFilter(
			"conversations",
			"kind='private' && pair_key={:pairKey}",
			dbx.Params{"pairKey": pairKey},
		)
		if err == nil {
			return router.NewBadRequestError("A private chat already exists for these users.", nil)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		e.Record.Set("kind", "private")
		e.Record.Set("members", sortedStrings(members))
		e.Record.Set("created_by", e.Auth.Id)
		e.Record.Set("pair_key", pairKey)
		e.Record.Set("title", "")

		return e.Next()
	})

	app.OnRecordCreateRequest("messages").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.Auth == nil {
			return router.NewForbiddenError("Sign in to send messages.", nil)
		}

		conversation, err := e.App.FindRecordById("conversations", e.Record.GetString("conversation"))
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return router.NewBadRequestError("Conversation was not found.", nil)
			}

			return err
		}

		if !e.HasSuperuserAuth() && !containsString(conversation.GetStringSlice("members"), e.Auth.Id) {
			return router.NewForbiddenError("You are not a member of this conversation.", nil)
		}

		if !e.HasSuperuserAuth() {
			e.Record.Set("sender", e.Auth.Id)
		}
		kind := e.Record.GetString("kind")
		if kind == "" {
			kind = "text"
			e.Record.Set("kind", "text")
		}
		body := strings.TrimSpace(e.Record.GetString("body"))
		e.Record.Set("body", body)

		switch kind {
		case "text":
			if body == "" {
				return router.NewBadRequestError("Message text is required.", nil)
			}
		case "image", "file", "voice":
			// Body is an optional caption for attachment-backed messages.
		default:
			return router.NewBadRequestError("Invalid message kind.", nil)
		}

		return e.Next()
	})

	app.OnRecordAfterCreateSuccess("messages").BindFunc(func(e *core.RecordEvent) error {
		conversation, err := e.App.FindRecordById("conversations", e.Record.GetString("conversation"))
		if err != nil {
			return err
		}

		conversation.Set("last_message_text", getMessagePreview(e.Record))
		conversation.Set("last_message_at", e.Record.GetString("created"))

		if err := e.App.Save(conversation); err != nil {
			return err
		}

		return e.Next()
	})
}

func getMessagePreview(record *core.Record) string {
	body := strings.TrimSpace(record.GetString("body"))
	if body != "" {
		return body
	}

	switch record.GetString("kind") {
	case "image":
		return "Photo"
	case "file":
		attachments := record.GetStringSlice("attachments")
		if len(attachments) > 0 {
			return formatStoredAttachmentName(attachments[0])
		}

		return "File"
	case "voice":
		return "Voice message"
	default:
		return "Message"
	}
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

func prepareConversationRecord(record *core.Record) {
	if record.GetString("kind") == "" {
		record.Set("kind", "private")
	}

	members := uniqueStrings(record.GetStringSlice("members"))
	record.Set("members", sortedStrings(members))

	if record.GetString("kind") == "private" && len(members) == 2 {
		record.Set("pair_key", friendshipPairKey(members[0], members[1]))
	}
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
