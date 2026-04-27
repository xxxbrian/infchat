# LiveKit Service

This directory holds the self-hosted LiveKit configuration used for local development.

The development config uses a local Redis container and a fixed development API key pair:

```txt
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret
```

Do not reuse these credentials outside local development.
