package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

var avatarThumbVariants = []string{"96x96", "160x160", "512x512", "1024x1024"}

func init() {
	m.Register(func(app core.App) error {
		if err := ensureAvatarThumbs(app, "profiles"); err != nil {
			return err
		}

		return ensureAvatarThumbs(app, "conversations")
	}, func(app core.App) error {
		return nil
	})
}

func ensureAvatarThumbs(app core.App, collectionName string) error {
	collection, err := app.FindCollectionByNameOrId(collectionName)
	if err != nil {
		return err
	}

	field, ok := collection.Fields.GetByName("avatar").(*core.FileField)
	if !ok {
		return nil
	}

	field.Thumbs = mergeStrings(field.Thumbs, avatarThumbVariants)

	return app.Save(collection)
}

func mergeStrings(current []string, additions []string) []string {
	seen := make(map[string]bool, len(current)+len(additions))
	merged := make([]string, 0, len(current)+len(additions))
	for _, value := range current {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		merged = append(merged, value)
	}
	for _, value := range additions {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		merged = append(merged, value)
	}

	return merged
}
