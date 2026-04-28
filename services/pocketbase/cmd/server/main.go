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

	if err := app.Start(); err != nil {
		log.Fatal(err)
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
