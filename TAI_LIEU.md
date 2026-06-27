# LLM Gateway — Tài liệu & ghi chú phỏng vấn

## 1. Dự án này là gì?

Một **gateway (cổng trung gian)** đứng giữa ứng dụng của bạn và các nhà cung cấp LLM (OpenAI, Anthropic). App chỉ gọi tới gateway, còn gateway lo những phần "khó nhằn" khi đưa AI lên production:

- **Fallback nhiều provider**: provider chính lỗi → tự chuyển provider dự phòng
- **Cache**: request giống nhau trả lời từ cache → tiết kiệm tiền + giảm độ trễ
- **Cost tracking**: đếm token và quy ra USD theo bảng giá
- **Rate limit**: giới hạn số request theo từng API key (sliding window)
- **Streaming**: hỗ trợ SSE (trả lời từng phần như ChatGPT)
- **Observability**: log dạng JSON + dashboard metrics realtime

Điểm hay: API **tương thích OpenAI**, nên app cũ chỉ cần đổi `base_url` là cắm vào được.

## 2. Vì sao công ty cần gateway?

Mỗi team làm tính năng AI đều phải tự dựng lại: cache, retry, fallback, đo chi phí, giới hạn tần suất. Gateway gom tất cả vào **một chỗ duy nhất** → code ứng dụng đơn giản, và có một nơi để kiểm soát + quan sát chi phí.

## 3. Luồng xử lý một request

```
client → /v1/chat/completions
  → auth (kiểm tra Bearer key)
  → rate limit (theo key)
  → tra cache → nếu trúng: trả luôn (chi phí $0)
  → chuỗi provider có fallback: mock → openai → anthropic
  → tính token + chi phí
  → ghi metrics + log
```

## 4. Các quyết định thiết kế (hay bị hỏi)

**Tại sao API theo chuẩn OpenAI?**
Vì hệ sinh thái (SDK, thư viện) đều nói "tiếng OpenAI". Theo chuẩn này thì khách hàng tích hợp gần như không cần sửa code. Adapter Anthropic tự dịch sang format `/v1/messages` của Claude.

**Cache key tính thế nào?**
Hash SHA-256 của các trường ảnh hưởng đến output: `model`, `messages`, `temperature`, `top_p`, `max_tokens`. Cờ `stream` bị bỏ qua để bản streaming và non-streaming dùng chung cache.

**Fallback khi streaming khác gì non-streaming?**
Non-streaming fallback thoải mái. Streaming **chỉ fallback được trước khi gửi byte đầu tiên** — vì khi đã stream dở mà đổi provider thì client nhận nội dung lẫn lộn. Code đọc chunk đầu tiên; nếu lỗi ngay từ đầu mới chuyển provider, còn đã stream rồi thì commit luôn provider đó.

**Rate limit kiểu gì?**
Sliding window: lưu mảng timestamp mỗi key, đếm số request trong cửa sổ thời gian. Chính xác hơn fixed-window (tránh dồn request ở ranh giới cửa sổ).

**Cache + rate limit hiện tại là in-memory — hạn chế?**
Chỉ đúng khi chạy 1 instance. Scale nhiều instance phải đưa state ra **Redis**. Đây là câu trả lời "ăn điểm" khi được hỏi về scaling.

## 4b. Reliability (timeout / retry / circuit breaker)

Mỗi lần gọi provider đi qua 3 lớp bảo vệ (cấu hình trong `.env`):

1. **Timeout** (`REQUEST_TIMEOUT_MS`): gọi quá lâu thì hủy (dùng `AbortController`), tránh treo vô hạn.
2. **Retry + exponential backoff** (`RETRY_MAX`, `RETRY_BASE_MS`): lỗi tạm thời (429, 5xx, timeout, lỗi mạng) thì thử lại **chính provider đó** với thời gian chờ tăng dần + jitter. Lỗi "cứng" (400/401/403) thì bỏ ngay, không retry (retry request sai cũng vô ích).
3. **Circuit breaker**: một provider lỗi liên tiếp N lần thì bị "mở mạch" và bị bỏ qua trong một khoảng cooldown — gateway không phí thời gian gọi provider đang chết. Sau cooldown chuyển sang "half-open" để thử lại.

Chỉ khi đã qua hết 3 lớp mà vẫn lỗi thì request mới **fallback** sang provider kế tiếp.

**Vì sao 429/5xx thì retry mà 400/401 thì không?**
429/5xx là lỗi tạm thời (server quá tải, throttling) → chờ rồi thử lại có thể thành công. 400/401/403 là lỗi từ phía request (sai tham số, sai key) → thử lại bao nhiêu lần cũng vẫn lỗi, chỉ tốn thời gian.

**Circuit breaker giải quyết vấn đề gì?**
Khi một provider chết, nếu cứ gọi rồi chờ timeout cho từng request thì latency của cả hệ thống tăng vọt. Breaker "ngắt" sớm để fail nhanh và dồn tải sang provider khỏe.

## 4c. Embeddings & RAG

Gateway có endpoint `POST /v1/embeddings` (chuẩn OpenAI) để biến văn bản thành **vector**. Đây là nửa "retrieval" của RAG:

1. Embed các tài liệu → lưu vector (vào vector DB như Chroma/Qdrant/pgvector)
2. Khi có câu hỏi → embed câu hỏi → tìm vector gần nhất (cosine similarity)
3. Nhét tài liệu liên quan vào prompt → gọi `/v1/chat/completions`

File `examples/semantic-search.mjs` demo bước 1–2 chạy thật qua gateway. Provider không hỗ trợ embeddings (như Anthropic) sẽ tự động bị bỏ qua trong chuỗi fallback nhờ cơ chế lọc theo "capability".

**Vì sao cùng một text luôn cho ra cùng một vector?**
Embedding là hàm tất định (deterministic) — cùng input + cùng model → cùng output. Nhờ vậy có thể cache. Mock provider của dự án dùng hash + PRNG có seed để tạo vector tất định, chạy offline cho demo.

**Cosine similarity là gì?**
Đo góc giữa 2 vector: 1 = giống hệt hướng, 0 = không liên quan, -1 = ngược nhau. Dùng để xếp hạng độ liên quan ngữ nghĩa giữa câu hỏi và tài liệu.

## 4d. Smart routing (giống 9router / OpenRouter)

Định tuyến điều khiển bằng file `routes.json` ở thư mục gốc. Nó biến tên model client gửi thành một **danh sách target** `{provider, model}` theo thứ tự fallback.

- **Alias**: client gọi tên ảo ổn định (`fast`, `smart`) → gateway map sang model thật. Đổi backend không cần sửa code client.
- **Tiered routing**: target gom theo "tầng" (tier), thử theo thứ tự khai báo trong `tiers` (vd rẻ trước, đắt sau). Lỗi thì rớt xuống tầng kế.
- **Load balancing**: nhiều target cùng tầng → chia tải bằng **weighted round-robin** (theo `weight`).
- **Latency routing**: đặt `ROUTING_STRATEGY=latency` → trong cùng tầng, ưu tiên target có độ trễ EWMA thấp nhất (nhanh nhất). Target chưa đo thì thử trước để thu thập số liệu.

Nếu model không có trong `routes.json` → dùng mặc định: thử lần lượt các provider trong `PROVIDER_ORDER` với chính tên model đó.

**EWMA là gì?**
Exponential Weighted Moving Average — trung bình động có trọng số: `mới = α*mẫu + (1-α)*cũ`. Phản ứng nhanh với thay đổi gần đây nhưng vẫn làm mượt nhiễu. Dùng để theo dõi độ trễ của từng target.

**Vì sao tách "tên model client gửi" khỏi "model thật"?**
Để có một lớp gián tiếp (indirection): client chỉ biết `fast`/`smart`, còn gateway tự do đổi provider/model thật, làm A/B test, hoặc failover mà client không hề hay biết. Đây chính là giá trị cốt lõi của một router như OpenRouter/9router.

## 4e. Per-key budget / quota

Mỗi API key có 2 hạn mức/ngày: **số request** và **chi phí USD**. Vượt một trong hai → trả **HTTP 429** (`budget_exceeded`), kèm `Retry-After` trỏ tới nửa đêm UTC kế tiếp (lúc usage reset).

- Hạn mức riêng từng key khai báo trong `budgets.json`; key không có override thì dùng mặc định (`DEFAULT_DAILY_REQUESTS`, `DEFAULT_DAILY_COST_USD`).
- `null` = không giới hạn.
- Mọi response trả header `X-Budget-*` để client tự điều tiết.
- Xem usage tại `/admin/usage` và trên dashboard.

**Cách đếm:** request quota tính ngay ở middleware (kể cả request cache hit hay lỗi). Chi phí thì cộng sau khi gọi provider xong (cache hit = $0). Cho phép request làm vượt budget hoàn tất, nhưng request sau đó bị chặn (soft cap) — đơn giản và đủ dùng.

**Vì sao reset theo ngày UTC mà không cần cron job?**
Usage lưu theo "bucket" gắn với chuỗi ngày `YYYY-MM-DD` (UTC). Sang ngày mới, key bucket đổi → tự động đếm lại từ 0, không cần job dọn dẹp.

**Khác gì rate limit?**
Rate limit chặn theo *tần suất ngắn hạn* (vd 30 req/phút) để bảo vệ hệ thống. Budget chặn theo *tổng tiêu thụ trong ngày* (số request + chi phí) để kiểm soát chi phí. Hai cơ chế bổ sung cho nhau.

## 4f. Multi-key rotation (giống "combo" của 9router)

Mỗi provider nhận **nhiều API key** (phân tách bằng dấu phẩy: `GEMINI_API_KEY=key1,key2,key3`). Gateway xoay vòng (round-robin) qua các key, và khi một key trả 429 thì cho nó "nghỉ" (cooldown) một khoảng `KEY_COOLDOWN_SECONDS` rồi mới dùng lại.

- Kết hợp với retry: một request gặp 429 → đánh dấu key đó nghỉ + ném lỗi retryable → retry tự lấy key khác → thành công ngay. Người dùng không thấy gián đoạn.
- Nếu mọi key đều đang nghỉ → provider coi như tạm hết quota → fallback sang provider khác.
- Xem tình trạng pool (số key sẵn sàng / đang nghỉ) ở `/admin/metrics` và dashboard.

**Vì sao đây là tính năng "ăn tiền"?**
Đây chính là cách các router như 9router "không bao giờ dính rate limit": gộp quota của nhiều tài khoản/key lại, tự né key đang bị giới hạn. Tăng throughput mà không phải nâng cấp gói trả phí.

**Round-robin key khác round-robin provider (load balancing) thế nào?**
Load balancing (mục 4d) chia tải giữa các *provider/model khác nhau* cùng phục vụ một logical model. Key rotation chia tải giữa nhiều *key của cùng một provider*. Hai tầng này hoạt động độc lập và bổ sung nhau.

## 4g. Token saver (giảm token = giảm tiền)

Bật `TOKEN_SAVER_ENABLED=true` để cắt request chat trước khi gửi tới provider:
- Nén khoảng trắng thừa trong nội dung message.
- Chỉ giữ `TOKEN_SAVER_MAX_MESSAGES` message gần nhất (không tính system).
- Bỏ bớt message cũ nhất cho tới khi token ước lượng lọt dưới `TOKEN_SAVER_MAX_INPUT_TOKENS`.

Luôn giữ lại system message và message mới nhất (để request vẫn hợp lệ). Tổng token tiết kiệm được theo dõi ở `/admin/metrics`.

**Vì sao cắt được mà không hỏng hội thoại?**
Message gần đây mang nhiều ngữ cảnh liên quan nhất; message cũ thường ít ảnh hưởng tới câu trả lời hiện tại. Giữ system (chứa chỉ dẫn) + N message cuối là cân bằng tốt giữa chi phí và chất lượng. Đây là chiến lược "sliding window" cho context.

**Hàm `applyTokenSaver` là pure function — vì sao quan trọng?**
Không mutate input, chỉ trả về bản mới + stats → dễ test, dễ suy luận, không gây tác dụng phụ ngoài ý muốn.

**Đếm token bằng cách nào?**
Ưu tiên `usage` thật mà provider trả về. Nếu không có thì ước lượng ~4 ký tự/token. Production nên dùng tokenizer thật (`tiktoken`).

## 5. Cấu trúc thư mục

- `src/index.js` — khởi tạo server, ráp middleware + route
- `src/config.js` — đọc `.env` (tự viết, không cần thư viện)
- `src/providers/` — adapter từng provider + logic fallback
- `src/services/` — cache, cost, metrics, logger
- `src/middleware/` — auth, rate limit
- `src/routes/` — chat (lõi), embeddings, models, admin
- `src/routing/router.js` — smart routing (alias, tier, load balancing, latency)
- `src/services/budget.js` — per-key budget/quota
- `src/services/keypool.js` — xoay vòng nhiều API key / provider
- `src/services/tokenSaver.js` — cắt history / nén prompt giảm token
- `public/index.html` — dashboard
- `examples/semantic-search.mjs` — demo RAG retrieval
- `routes.json` — cấu hình định tuyến (alias / tier / target)
- `budgets.json` — hạn mức theo API key

## 6. Hướng phát triển tiếp (để nói "next steps")

- Redis cho cache + rate limit + circuit breaker (multi-instance)
- Xuất metrics ra Prometheus/OpenTelemetry
- Tokenizer thật thay cho ước lượng
- Tích hợp vector DB (Chroma/Qdrant/pgvector) để hoàn thiện RAG
- Đóng gói Docker + docker-compose (kèm Redis)

## 7. Câu hỏi tự luyện

1. Gateway giúp tiết kiệm chi phí LLM bằng những cơ chế nào?
2. Vì sao streaming không thể fallback giữa chừng?
3. Sliding window khác fixed window ở điểm nào?
4. Nếu chạy 3 instance sau load balancer, cache và rate limit sẽ sai ở đâu, sửa thế nào?
5. Làm sao đảm bảo cache không trả nhầm kết quả khi tham số sinh (temperature) khác nhau?
6. Vì sao lỗi 429/5xx thì retry mà 400/401 thì không?
7. Circuit breaker có 3 trạng thái nào, chuyển trạng thái khi nào?
8. Vì sao streaming không thể retry/fallback sau khi đã gửi byte đầu tiên?
9. Embeddings dùng để làm gì trong RAG? Mô tả luồng 3 bước.
10. Vì sao embedding của cùng một text luôn giống nhau, và điều đó giúp cache thế nào?
11. Model alias giúp ích gì? Vì sao nên tách tên client gửi khỏi model thật?
12. Weighted round-robin và latency-based routing khác nhau khi nào nên dùng cái nào?
13. Budget/quota khác rate limit ở điểm nào?
14. Vì sao usage budget reset được theo ngày mà không cần cron job?
15. Multi-key rotation giúp gì? Khi một key dính 429 thì điều gì xảy ra?
16. Key rotation khác load balancing giữa các provider thế nào?
17. Token saver cắt context kiểu gì mà không làm hỏng hội thoại?
18. Vì sao nên viết các hàm xử lý (router, token saver) dạng pure function?
