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

		privacySettings := core.NewBaseCollection("privacy_settings")
		privacySettings.ListRule = pointer("user = @request.auth.id")
		privacySettings.ViewRule = pointer("user = @request.auth.id")
		privacySettings.CreateRule = nil
		privacySettings.UpdateRule = pointer("user = @request.auth.id")
		privacySettings.DeleteRule = nil
		privacySettings.Fields.Add(
			&core.RelationField{
				Name:          "user",
				CollectionId:  users.Id,
				CascadeDelete: true,
				MaxSelect:     1,
				Required:      true,
			},
			&core.BoolField{Name: "show_in_public_suggestions"},
			&core.BoolField{Name: "show_in_mutual_suggestions"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		privacySettings.AddIndex("idx_privacy_settings_user", true, "user", "")

		if err := app.Save(privacySettings); err != nil {
			return err
		}

		return backfillPrivacySettings(app)
	}, func(app core.App) error {
		privacySettings, err := app.FindCollectionByNameOrId("privacy_settings")
		if err == nil {
			return app.Delete(privacySettings)
		}
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}

		return err
	})
}

func backfillPrivacySettings(app core.App) error {
	users, err := app.FindAllRecords("users")
	if err != nil {
		return err
	}

	privacySettings, err := app.FindCollectionByNameOrId("privacy_settings")
	if err != nil {
		return err
	}

	for _, user := range users {
		if _, err := app.FindFirstRecordByFilter("privacy_settings", "user={:user}", dbx.Params{"user": user.Id}); err == nil {
			continue
		} else if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		settings := core.NewRecord(privacySettings)
		settings.Set("user", user.Id)
		settings.Set("show_in_public_suggestions", false)
		settings.Set("show_in_mutual_suggestions", true)

		if err := app.Save(settings); err != nil {
			return err
		}
	}

	return nil
}
