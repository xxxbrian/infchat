package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		pushDevices, err := app.FindCollectionByNameOrId("push_devices")
		if err != nil {
			return err
		}

		if pushDevices.Fields.GetByName("apns_disabled_at") == nil {
			pushDevices.Fields.Add(&core.DateField{Name: "apns_disabled_at"})
		}
		if pushDevices.Fields.GetByName("voip_disabled_at") == nil {
			pushDevices.Fields.Add(&core.DateField{Name: "voip_disabled_at"})
		}
		if pushDevices.Fields.GetByName("fcm_disabled_at") == nil {
			pushDevices.Fields.Add(&core.DateField{Name: "fcm_disabled_at"})
		}

		return app.Save(pushDevices)
	}, func(app core.App) error {
		pushDevices, err := app.FindCollectionByNameOrId("push_devices")
		if err != nil {
			return err
		}

		pushDevices.Fields.RemoveByName("apns_disabled_at")
		pushDevices.Fields.RemoveByName("voip_disabled_at")
		pushDevices.Fields.RemoveByName("fcm_disabled_at")

		return app.Save(pushDevices)
	})
}
