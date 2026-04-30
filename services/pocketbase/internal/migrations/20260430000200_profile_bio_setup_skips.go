package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return err
		}

		if profiles.Fields.GetByName("bio") == nil {
			profiles.Fields.Add(&core.TextField{Name: "bio", Max: 160})
		}

		if profiles.Fields.GetByName("setup_skipped_fields") == nil {
			profiles.Fields.Add(&core.TextField{Name: "setup_skipped_fields", Max: 1000})
		}

		return app.Save(profiles)
	}, func(app core.App) error {
		profiles, err := app.FindCollectionByNameOrId("profiles")
		if err != nil {
			return err
		}

		profiles.Fields.RemoveByName("setup_skipped_fields")
		profiles.Fields.RemoveByName("bio")

		return app.Save(profiles)
	})
}
