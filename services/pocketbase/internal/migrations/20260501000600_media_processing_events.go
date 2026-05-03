package migrations

import (
	"github.com/pocketbase/pocketbase/core"
	m "github.com/pocketbase/pocketbase/migrations"
)

func init() {
	m.Register(func(app core.App) error {
		events, err := app.FindCollectionByNameOrId("conversation_events")
		if err != nil {
			return err
		}
		if typeField, ok := events.Fields.GetByName("type").(*core.SelectField); ok {
			typeField.Values = appendMissingSelectValues(typeField.Values, "message.media_processed")
		}

		return app.Save(events)
	}, func(app core.App) error {
		events, err := app.FindCollectionByNameOrId("conversation_events")
		if err != nil {
			return err
		}
		if typeField, ok := events.Fields.GetByName("type").(*core.SelectField); ok {
			typeField.Values = removeSelectValue(typeField.Values, "message.media_processed")
		}

		return app.Save(events)
	})
}

func appendMissingSelectValues(values []string, additions ...string) []string {
	seen := make(map[string]struct{}, len(values)+len(additions))
	result := make([]string, 0, len(values)+len(additions))
	for _, value := range values {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	for _, value := range additions {
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}

	return result
}

func removeSelectValue(values []string, removed string) []string {
	result := values[:0]
	for _, value := range values {
		if value == removed {
			continue
		}
		result = append(result, value)
	}

	return result
}
