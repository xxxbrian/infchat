package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}

		if kindField, ok := messages.Fields.GetByName("kind").(*core.SelectField); ok {
			kindField.Values = []string{"text", "image", "file", "voice"}
		}

		if bodyField, ok := messages.Fields.GetByName("body").(*core.TextField); ok {
			bodyField.Required = false
		}

		if messages.Fields.GetByName("attachments") == nil {
			messages.Fields.Add(&core.FileField{
				Name:      "attachments",
				MaxSelect: 5,
				MaxSize:   25 * 1024 * 1024,
				Thumbs:    []string{"720x720", "320x320"},
			})
		}

		return app.Save(messages)
	}, func(app core.App) error {
		messages, err := app.FindCollectionByNameOrId("messages")
		if err != nil {
			return err
		}

		if kindField, ok := messages.Fields.GetByName("kind").(*core.SelectField); ok {
			kindField.Values = []string{"text", "image", "voice"}
		}

		if bodyField, ok := messages.Fields.GetByName("body").(*core.TextField); ok {
			bodyField.Required = true
		}

		messages.Fields.RemoveByName("attachments")

		return app.Save(messages)
	})
}
