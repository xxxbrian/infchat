package main

import (
	"log"
	"strings"

	_ "infchat/services/pocketbase/internal/migrations"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func main() {
	app := pocketbase.New()

	bindAuthHooks(app)

	if err := app.Start(); err != nil {
		log.Fatal(err)
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
	username := strings.ToLower(strings.TrimSpace(record.GetString("username")))
	record.Set("username", username)
}
