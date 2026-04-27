package migrations

import (
	"strings"

	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		collection.ListRule = pointer("id = @request.auth.id")
		collection.ViewRule = pointer("id = @request.auth.id")
		collection.CreateRule = pointer("")
		collection.UpdateRule = pointer("id = @request.auth.id")
		collection.DeleteRule = nil

		if emailField, ok := collection.Fields.GetByName("email").(*core.EmailField); ok {
			emailField.Required = false
		}

		usernameField, ok := collection.Fields.GetByName("username").(*core.TextField)
		if !ok || usernameField == nil {
			usernameField = &core.TextField{Name: "username"}
			collection.Fields.Add(usernameField)
		}

		usernameField.Required = true
		usernameField.Min = 3
		usernameField.Max = 32
		usernameField.Pattern = "^[a-z0-9_]+$"
		usernameField.Presentable = true

		collection.PasswordAuth.Enabled = true
		collection.PasswordAuth.IdentityFields = []string{"username"}
		collection.OAuth2.Enabled = false
		collection.OTP.Enabled = false
		collection.MFA.Enabled = false

		collection.Indexes = removeIndex(collection.Indexes, "idx_users_username")
		collection.AddIndex("idx_users_username", true, "username", "")

		return app.Save(collection)
	}, func(app core.App) error {
		collection, err := app.FindCollectionByNameOrId("users")
		if err != nil {
			return err
		}

		if emailField, ok := collection.Fields.GetByName("email").(*core.EmailField); ok {
			emailField.Required = true
		}

		collection.PasswordAuth.IdentityFields = []string{"email"}
		collection.Indexes = removeIndex(collection.Indexes, "idx_users_username")

		return app.Save(collection)
	})
}

func pointer(value string) *string {
	return &value
}

func removeIndex(indexes []string, name string) []string {
	filtered := indexes[:0]
	for _, index := range indexes {
		if !strings.Contains(index, name) {
			filtered = append(filtered, index)
		}
	}
	return filtered
}
