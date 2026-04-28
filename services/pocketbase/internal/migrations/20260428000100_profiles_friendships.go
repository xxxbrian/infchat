package migrations

import (
	"database/sql"
	"errors"
	"strings"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		profiles := core.NewBaseCollection("profiles")
		profiles.ListRule = pointer("@request.auth.id != ''")
		profiles.ViewRule = pointer("@request.auth.id != ''")
		profiles.CreateRule = nil
		profiles.UpdateRule = pointer("user = @request.auth.id")
		profiles.DeleteRule = nil
		profiles.Fields.Add(
			&core.RelationField{
				Name:          "user",
				CollectionId:  users.Id,
				CascadeDelete: true,
				MaxSelect:     1,
				Required:      true,
			},
			&core.TextField{Name: "username", Required: true, Min: 3, Max: 32, Pattern: "^[a-z0-9_]+$", Presentable: true},
			&core.TextField{Name: "display_name", Required: true, Max: 48, Presentable: true},
			&core.FileField{Name: "avatar", MaxSelect: 1, MaxSize: 5 * 1024 * 1024, MimeTypes: []string{"image/jpeg", "image/png", "image/webp"}, Thumbs: []string{"160x160"}},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		profiles.AddIndex("idx_profiles_user", true, "user", "")
		profiles.AddIndex("idx_profiles_username", true, "username", "")

		if err := app.Save(profiles); err != nil {
			return err
		}

		friendships := core.NewBaseCollection("friendships")
		friendships.ListRule = pointer("requester = @request.auth.id || recipient = @request.auth.id")
		friendships.ViewRule = pointer("requester = @request.auth.id || recipient = @request.auth.id")
		friendships.CreateRule = pointer("@request.auth.id != ''")
		friendships.UpdateRule = pointer("requester = @request.auth.id || recipient = @request.auth.id")
		friendships.DeleteRule = nil
		friendships.Fields.Add(
			&core.RelationField{Name: "requester", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.RelationField{Name: "recipient", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.TextField{Name: "pair_key", Required: true, Max: 64},
			&core.SelectField{Name: "status", Required: true, Values: []string{"pending", "accepted", "declined", "canceled"}},
			&core.DateField{Name: "accepted_at"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		friendships.AddIndex("idx_friendships_requester", false, "requester", "")
		friendships.AddIndex("idx_friendships_recipient", false, "recipient", "")
		friendships.AddIndex("idx_friendships_active_pair", true, "pair_key", "status = 'pending' OR status = 'accepted'")

		if err := app.Save(friendships); err != nil {
			return err
		}

		return backfillProfiles(app)
	}, func(app core.App) error {
		friendships, err := app.FindCollectionByNameOrId("friendships")
		if err == nil {
			if err := app.Delete(friendships); err != nil {
				return err
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err == nil {
			return app.Delete(profiles)
		}

		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}

		return err
	})
}

func backfillProfiles(app core.App) error {
	profiles, err := app.FindCollectionByNameOrId("profiles")
	if err != nil {
		return err
	}

	users, err := app.FindAllRecords("users")
	if err != nil {
		return err
	}

	for _, user := range users {
		username := strings.ToLower(strings.TrimSpace(user.GetString("username")))
		if username == "" {
			continue
		}

		profile := core.NewRecord(profiles)
		profile.Set("user", user.Id)
		profile.Set("username", username)
		profile.Set("display_name", username)

		if err := app.Save(profile); err != nil {
			return err
		}
	}

	return nil
}
