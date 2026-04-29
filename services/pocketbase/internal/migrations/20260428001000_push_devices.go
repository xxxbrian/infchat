package migrations

import (
	"database/sql"
	"errors"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		users, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		pushDevices := core.NewBaseCollection("push_devices")
		pushDevices.ListRule = pointer("user = @request.auth.id")
		pushDevices.ViewRule = pointer("user = @request.auth.id")
		pushDevices.CreateRule = nil
		pushDevices.UpdateRule = nil
		pushDevices.DeleteRule = nil
		pushDevices.Fields.Add(
			&core.RelationField{Name: "user", CollectionId: users.Id, CascadeDelete: true, MaxSelect: 1, Required: true},
			&core.TextField{Name: "device_id", Required: true, Max: 160},
			&core.SelectField{Name: "platform", Required: true, Values: []string{"ios", "android"}},
			&core.SelectField{Name: "environment", Required: true, Values: []string{"sandbox", "production"}},
			&core.TextField{Name: "apns_token", Max: 512},
			&core.TextField{Name: "voip_token", Max: 512},
			&core.TextField{Name: "fcm_token", Max: 512},
			&core.TextField{Name: "app_version", Max: 80},
			&core.DateField{Name: "last_seen_at"},
			&core.DateField{Name: "disabled_at"},
			&core.AutodateField{Name: "created", OnCreate: true},
			&core.AutodateField{Name: "updated", OnCreate: true, OnUpdate: true},
		)
		pushDevices.AddIndex("idx_push_devices_user_device_platform", true, "user, device_id, platform", "")
		pushDevices.AddIndex("idx_push_devices_user_platform", false, "user, platform, environment", "")

		return app.Save(pushDevices)
	}, func(app core.App) error {
		pushDevices, err := app.FindCollectionByNameOrId("push_devices")
		if err == nil {
			return app.Delete(pushDevices)
		}

		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}

		return err
	})
}
