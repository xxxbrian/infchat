package main

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/types"
	"github.com/sideshow/apns2"
	"github.com/sideshow/apns2/token"
)

const apnsRequestTimeout = 8 * time.Second

type pushDeviceRegisterRequest struct {
	ApnsToken   string `json:"apnsToken" form:"apnsToken"`
	AppVersion  string `json:"appVersion" form:"appVersion"`
	DeviceId    string `json:"deviceId" form:"deviceId"`
	Environment string `json:"environment" form:"environment"`
	FcmToken    string `json:"fcmToken" form:"fcmToken"`
	Platform    string `json:"platform" form:"platform"`
	VoipToken   string `json:"voipToken" form:"voipToken"`
}

type apnsProvider struct {
	bundleID          string
	developmentClient *apns2.Client
	productionClient  *apns2.Client
}

type apnsAlert struct {
	Body  string `json:"body"`
	Title string `json:"title"`
}

type apnsAPS struct {
	Alert            *apnsAlert `json:"alert,omitempty"`
	Category         string     `json:"category,omitempty"`
	ContentAvailable int        `json:"content-available,omitempty"`
	Sound            string     `json:"sound,omitempty"`
}

func bindPushRoutes(app *pocketbase.PocketBase) {
	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		group := se.Router.Group("/api/infchat/push")
		group.Bind(apis.RequireAuth("users"))

		group.POST("/register", func(e *core.RequestEvent) error {
			data := pushDeviceRegisterRequest{}
			if err := e.BindBody(&data); err != nil {
				return e.BadRequestError("Failed to read push device data.", err)
			}

			device, err := upsertPushDevice(e.App, e.Auth.Id, data)
			if err != nil {
				return err
			}

			return e.JSON(http.StatusOK, map[string]any{"pushDevice": device})
		})

		return se.Next()
	})
}

func upsertPushDevice(app core.App, userId string, data pushDeviceRegisterRequest) (*core.Record, error) {
	deviceId := normalizedDeviceId(data.DeviceId)
	platform := strings.ToLower(strings.TrimSpace(data.Platform))
	if platform != "ios" && platform != "android" {
		return nil, errors.New("push platform must be ios or android")
	}

	environment := normalizePushEnvironment(data.Environment)
	if environment == "" {
		return nil, errors.New("push environment must be sandbox or production")
	}

	apnsToken := strings.TrimSpace(data.ApnsToken)
	voipToken := strings.TrimSpace(data.VoipToken)
	fcmToken := strings.TrimSpace(data.FcmToken)
	if apnsToken == "" && voipToken == "" && fcmToken == "" {
		return nil, errors.New("at least one push token is required")
	}

	device, err := app.FindFirstRecordByFilter(
		"push_devices",
		"user={:userId} && device_id={:deviceId} && platform={:platform}",
		dbx.Params{"deviceId": deviceId, "platform": platform, "userId": userId},
	)
	if err != nil {
		collection, collectionErr := app.FindCollectionByNameOrId("push_devices")
		if collectionErr != nil {
			return nil, collectionErr
		}

		device = core.NewRecord(collection)
		device.Set("user", userId)
		device.Set("device_id", deviceId)
		device.Set("platform", platform)
	}

	now := types.NowDateTime()
	device.Set("environment", environment)
	if apnsToken != "" {
		device.Set("apns_token", apnsToken)
	}
	if voipToken != "" {
		device.Set("voip_token", voipToken)
	}
	if fcmToken != "" {
		device.Set("fcm_token", fcmToken)
	}
	device.Set("app_version", strings.TrimSpace(data.AppVersion))
	device.Set("last_seen_at", now)
	device.Set("disabled_at", "")

	if err := app.Save(device); err != nil {
		return nil, err
	}

	return device, nil
}

func sendMessagePushNotifications(app core.App, message *core.Record) {
	if message.GetString("kind") == "call" {
		return
	}

	conversation, err := app.FindRecordById("conversations", message.GetString("conversation"))
	if err != nil {
		log.Printf("push: could not load message conversation: %v", err)
		return
	}

	senderId := message.GetString("sender")
	senderName, _ := liveKitParticipantName(app, senderId)
	body := strings.TrimSpace(getMessagePreview(message))
	if body == "" {
		body = "New message"
	}

	payload := map[string]any{
		"aps": apnsAPS{
			Alert: &apnsAlert{Title: senderName, Body: body},
			Sound: "default",
		},
		"conversationId": conversation.Id,
		"messageId":      message.Id,
		"type":           "message",
	}

	for _, userId := range conversation.GetStringSlice("members") {
		if userId == senderId {
			continue
		}

		if err := sendAPNsToUserDevices(app, userId, "apns_token", apns2.PushTypeAlert, apns2.PriorityHigh, "", payload); err != nil {
			log.Printf("push: message notification failed for user %s: %v", userId, err)
		}
	}
}

func sendIncomingCallPushNotifications(app core.App, callRoom *core.Record) {
	conversation, err := app.FindRecordById("conversations", callRoom.GetString("conversation"))
	if err != nil {
		log.Printf("push: could not load call conversation: %v", err)
		return
	}

	callerId := callRoom.GetString("created_by")
	callerName, _ := liveKitParticipantName(app, callerId)
	callKind := callRoom.GetString("kind")
	payload := map[string]any{
		"aps": apnsAPS{
			Alert:            &apnsAlert{Title: callerName, Body: fmt.Sprintf("Incoming %s call", callKind)},
			ContentAvailable: 1,
			Sound:            "default",
		},
		"callerName":     callerName,
		"callRoomId":     callRoom.Id,
		"conversationId": conversation.Id,
		"handle":         callerName,
		"kind":           callKind,
		"type":           "call",
		"uuid":           callUUID(callRoom.Id),
	}

	for _, userId := range conversation.GetStringSlice("members") {
		if userId == callerId {
			continue
		}

		if err := sendAPNsToUserDevices(app, userId, "voip_token", apns2.PushTypeVOIP, apns2.PriorityHigh, ".voip", payload); err != nil {
			log.Printf("push: incoming call notification failed for user %s: %v", userId, err)
		}
	}
}

func sendAPNsToUserDevices(app core.App, userId string, tokenField string, pushType apns2.EPushType, priority int, topicSuffix string, payload map[string]any) error {
	provider, err := newAPNsProvider()
	if err != nil {
		log.Printf("push: APNs disabled: %v", err)
		return nil
	}

	devices, err := app.FindRecordsByFilter(
		"push_devices",
		"user={:userId} && platform='ios' && disabled_at=''",
		"-updated",
		0,
		0,
		dbx.Params{"userId": userId},
	)
	if err != nil {
		return err
	}

	for _, device := range devices {
		token := strings.TrimSpace(device.GetString(tokenField))
		if token == "" {
			continue
		}

		if err := provider.send(device.GetString("environment"), token, pushType, priority, topicSuffix, payload); err != nil {
			return err
		}
	}

	return nil
}

func newAPNsProvider() (*apnsProvider, error) {
	teamID := strings.TrimSpace(os.Getenv("APNS_TEAM_ID"))
	keyID := strings.TrimSpace(os.Getenv("APNS_KEY_ID"))
	bundleID := strings.TrimSpace(os.Getenv("APNS_BUNDLE_ID"))
	privateKeyPEM := strings.TrimSpace(os.Getenv("APNS_PRIVATE_KEY"))
	privateKeyBase64 := strings.TrimSpace(os.Getenv("APNS_PRIVATE_KEY_BASE64"))

	if privateKeyPEM == "" && privateKeyBase64 != "" {
		decoded, err := base64.StdEncoding.DecodeString(privateKeyBase64)
		if err != nil {
			return nil, fmt.Errorf("APNS_PRIVATE_KEY_BASE64 is invalid: %w", err)
		}
		privateKeyPEM = string(decoded)
	}

	if teamID == "" || keyID == "" || bundleID == "" || privateKeyPEM == "" {
		return nil, errors.New("APNS_TEAM_ID, APNS_KEY_ID, APNS_BUNDLE_ID, and APNS_PRIVATE_KEY are required")
	}

	authKey, err := token.AuthKeyFromBytes([]byte(strings.ReplaceAll(privateKeyPEM, `\n`, "\n")))
	if err != nil {
		return nil, err
	}
	authToken := &token.Token{
		AuthKey: authKey,
		KeyID:   keyID,
		TeamID:  teamID,
	}

	return &apnsProvider{
		bundleID:          bundleID,
		developmentClient: apns2.NewTokenClient(authToken).Development(),
		productionClient:  apns2.NewTokenClient(authToken).Production(),
	}, nil
}

func (provider *apnsProvider) send(environment string, deviceToken string, pushType apns2.EPushType, priority int, topicSuffix string, payload map[string]any) error {
	client := provider.developmentClient
	if normalizePushEnvironment(environment) == "production" {
		client = provider.productionClient
	}

	notification := &apns2.Notification{
		DeviceToken: deviceToken,
		Expiration:  time.Now().Add(callRingTimeout),
		Payload:     payload,
		Priority:    priority,
		PushType:    pushType,
		Topic:       provider.bundleID + topicSuffix,
	}
	if pushType == apns2.PushTypeAlert {
		notification.Expiration = time.Time{}
	}

	ctx, cancel := context.WithTimeout(context.Background(), apnsRequestTimeout)
	defer cancel()

	response, err := client.PushWithContext(ctx, notification)
	if err != nil {
		return err
	}

	if response.Sent() {
		return nil
	}

	return fmt.Errorf("APNs returned %d: %s", response.StatusCode, response.Reason)
}

func normalizePushEnvironment(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "prod", "production":
		return "production"
	case "sandbox", "dev", "development", "":
		return "sandbox"
	default:
		return ""
	}
}

func callUUID(callRoomId string) string {
	sum := sha1.Sum([]byte("infchat-call:" + callRoomId))
	sum[6] = (sum[6] & 0x0f) | 0x50
	sum[8] = (sum[8] & 0x3f) | 0x80

	return fmt.Sprintf(
		"%x-%x-%x-%x-%x",
		sum[0:4],
		sum[4:6],
		sum[6:8],
		sum[8:10],
		sum[10:16],
	)
}
