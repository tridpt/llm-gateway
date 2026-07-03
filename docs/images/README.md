# Screenshots

Drop image files here and they'll render in the main README's **Screenshots**
section. The README references these exact filenames:

| Filename        | What to capture                                                        |
| --------------- | ---------------------------------------------------------------------- |
| `dashboard.png` | The live observability dashboard at <http://localhost:8080/dashboard>  |
| `chat.png`      | The team chat UI at <http://localhost:8080/chat> (a conversation open) |

## How to capture

1. Start the gateway: `npm start` (uses the mock provider, no keys needed).
2. Open the URL in a browser and make a couple of requests so there's data to show.
3. Take a screenshot and save it here with the filename above.

Tips:

- Use a viewport around 1280–1440px wide for a crisp, readable capture.
- PNG keeps UI text sharp. Keep each image under ~500 KB if you can (compress
  with e.g. tinypng.com) so the repo stays light.
- Avoid capturing any real API keys or private data — the mock provider and
  demo keys are perfect for this.
