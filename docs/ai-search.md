# AI search and voice input

Type a request into the album, film, track or Subscriptions search box, then choose **AI search** below **Filter by text** in the suggestions. Or use the microphone inside the search box and choose **Stop recording and search** when finished. Dictation transcribes the request and runs the search automatically. Successful searches immediately apply the resulting filters. Use the eye icon inside the search box to review the original request, interpretation, applied conditions and assumptions. The resulting filters use the normal browse controls and survive reloads and detail navigation.

Examples:

- “Show rock albums I've only listened to a little, with a high Rate Your Music score.”
- “Show albums I used to listen to a lot, but haven't listened to much in the last five years.”
- “Show unwatched films rated at least 8 on IMDb, newest first.”
- “Tracks from my Road trip playlist I've never played.”
- “Long woodworking videos from @examplechannel published this year, most viewed first.”

Each request replaces the current search. It does not edit library records, start scrapes or discover media outside the library. A request that cannot be expressed with the available filters asks for clarification instead of applying a partial search. Review the generated conditions: a model can misinterpret a request even when its output passes validation.

## Listening and ratings

Listening requests use the same [custom listening filters](lastfm-scrobbles.md) as the manual controls. They count linked, stored Last.fm **track scrobbles**, not full album plays. Complete the initial history sync before using them. Unlinked or unrecorded plays cannot contribute; stale history is flagged.

Vague terms have visible defaults: “only a little” means 1–10 scrobbles, “not much” means 0–10, “a lot” means at least 100, and “high RYM score” means at least 3.5/5. Explicit numbers override these choices. Earlier and recent listening are separate conditions; an all-time count is not substituted for listening before a cutoff. Date periods include both boundary days in UTC. Adjust any condition using the regular controls after applying it.

Tracks have no listening rules. A track request uses the track's **Scrobbles** and **Last listened** values, which count all-time linked scrobbles, so counts within a period ask for clarification. The track table has no result limit, so “top 10” sorts without capping.

Scores come from stored metadata. Searches do not fetch fresh ratings, and missing scores are excluded unless requested otherwise. AI search supports the public built-in fields; installation-specific plugin fields remain available through manual filters.

## Subscriptions

A Subscriptions request (`mediaType: subscription`) returns a plan over [the combined library](subscriptions.md#searching) of videos and podcast episodes: the search text, **Titles only**, channels and podcasts, type, published days, a duration range in seconds, and the sort. Plain-language lengths become ranges: under 4 minutes is at most 239 seconds, 4 to 20 minutes is 240 to 1,200, and over 20 minutes is at least 1,201. Views, likes and comments exist only for YouTube videos. Data that is not stored, such as watch history, asks for clarification. The Subscriptions browse page sends this request.

The model returns channel and podcast names as written in the request. The server matches each one to a subscribed channel or saved podcast, ignoring case: an exact title or @handle first, then a part of one title or handle. If a name matches no source or several, nothing is applied and the review lists the name, with candidates for an ambiguous name. The applied plan becomes the page's ordinary browse filters: one Any filter per channel or podcast, a Required type filter when one type is asked for, and inclusive UTC ranges.

## Models and configuration

- Interpretation: Cloudflare-hosted [`@cf/openai/gpt-oss-120b`](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/), with high reasoning effort and JSON output.
- Transcription: [`@cf/openai/whisper-large-v3-turbo`](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/), with voice activity detection.

The API Worker's Wrangler configuration includes an `AI` binding. An explicitly requested deployment of that configuration enables the binding; no browser token or additional provider key is needed. Ensure Workers AI is available on the target account. This feature does not itself deploy the application.

For the Node server, configure `CLOUDFLARE_AI_ACCOUNT_ID` and `CLOUDFLARE_AI_API_TOKEN` through the existing server environment loading and restart. Use a token scoped to Workers AI on the intended account. Do not put either value in browser configuration or commit it. When neither a Worker binding nor Node configuration is available, AI search shows that it is unavailable and ordinary browsing continues to work.

## Audio and data handling

Microphone recording requires HTTPS or localhost and a browser supporting MediaRecorder. The browser asks for microphone access when recording starts. Recordings stop at 60 seconds and are limited to 5 MB. Use the cancel icon to discard a recording or cancel a pending AI request. Leaving the library releases the microphone and cancels pending requests. Transcription automatically starts AI search; typing a new request while interpretation is pending cancels the older request. Failed or cancelled searches leave the current filters unchanged.

Only the submitted text and public filter definitions go to the text model. Recorded audio goes to the transcription model. Library records, listening history, stored tag vocabularies, subscribed channel and podcast names, plugin definitions and provider secrets are not sent to either model. Audio and raw prompts are not saved by the application; only applied browse conditions are retained in the URL and the existing browse preferences. API logs contain paths/statuses/timing, not request bodies. Cloudflare's own processing is governed by its [Workers AI data usage policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/).

The owner session and existing origin protection apply to every AI endpoint. Requests, recordings and model outputs are size-bounded and schema-validated. Generated fields and rating scales are checked before a plan can be applied. Each model call has a 60-second timeout and is not retried automatically.

## Verification

The AI service and API tests mock inference and use synthetic plans. They cover listening windows, ratings, track plans, Subscriptions plans, channel and podcast matching, unsupported fields, incomplete history, malformed output, transcription errors, authentication and request limits. Recording tests cover stop/cancel, permission failures, size and duration limits, and releasing microphone tracks. No live library scraping is needed.
