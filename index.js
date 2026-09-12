// ======================================================
// SERVER GỬI THÔNG BÁO FCM
// Nhận yêu cầu từ client → gửi push notification
// ======================================================

const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// Import service account key (tải từ Firebase Console)
let serviceAccount;
try {
  serviceAccount = require("./serviceAccountKey.json");
} catch (e) {
  console.error("❌ Không tìm thấy serviceAccountKey.json");
  console.error(
    "👉 Hãy tải file này từ Firebase Console → Project Settings → Service Accounts → Generate new private key",
  );
  process.exit(1);
}

// Khởi tạo Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// Khởi tạo Express
const app = express();

// Cho phép CORS từ mọi domain (để client gọi API)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);

app.use(express.json());

// ======================================================
// API: GỬI THÔNG BÁO
// POST /api/notify
// Body: { chatId, senderNickname, messageText, recipientUids, senderUid }
// ======================================================
app.post("/api/notify", async (req, res) => {
  try {
    const { chatId, senderNickname, messageText, recipientUids, senderUid } =
      req.body;

    console.log("📨 Nhận yêu cầu gửi thông báo:", {
      chatId,
      senderNickname,
      recipientCount: recipientUids ? recipientUids.length : 0,
    });

    if (
      !recipientUids ||
      !Array.isArray(recipientUids) ||
      recipientUids.length === 0
    ) {
      return res.json({
        success: true,
        sent: 0,
        message: "Không có người nhận",
      });
    }

    // Lấy tất cả FCM tokens của những người nhận
    const allTokens = [];
    for (const uid of recipientUids) {
      if (uid === senderUid) continue; // Không gửi cho chính người gửi

      try {
        const tokensSnap = await db
          .collection("users")
          .doc(uid)
          .collection("tokens")
          .get();

        tokensSnap.forEach((doc) => {
          const token = doc.data().token;
          if (token) {
            allTokens.push({ uid, token });
          }
        });
      } catch (e) {
        console.warn(`Không lấy được tokens cho ${uid}:`, e.message);
      }
    }

    if (allTokens.length === 0) {
      return res.json({ success: true, sent: 0, message: "Không có token" });
    }

    // Chuẩn bị payload
    const payload = {
      notification: {
        title: senderNickname || "Tin nhắn mới",
        body: messageText || "Bạn có tin nhắn mới",
      },
      data: {
        chatId: String(chatId || ""),
        senderUid: String(senderUid || ""),
        type: "new_message",
      },
      webpush: {
        notification: {
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          tag: chatId || "chat-msg",
          renotify: true,
        },
        fcmOptions: {
          link: "/",
        },
      },
    };

    // Gửi đến từng token
    const tokenStrings = allTokens.map((t) => t.token);
    let successCount = 0;
    let failureCount = 0;
    const invalidTokens = [];

    try {
      const response = await admin
        .messaging()
        .sendToDevice(tokenStrings, payload);

      successCount = response.successCount;
      failureCount = response.failureCount;

      // Xoá các token không còn hợp lệ
      response.results.forEach((result, index) => {
        if (!result.success) {
          const error = result.error;
          console.warn(`Token ${index} lỗi:`, error?.code);

          if (
            error &&
            (error.code === "messaging/invalid-registration-token" ||
              error.code === "messaging/registration-token-not-registered")
          ) {
            invalidTokens.push(allTokens[index]);
          }
        }
      });

      // Xoá token lỗi khỏi Firestore
      for (const { uid, token } of invalidTokens) {
        try {
          await db
            .collection("users")
            .doc(uid)
            .collection("tokens")
            .doc(token)
            .delete();
          console.log(`🗑️ Đã xoá token lỗi của ${uid}`);
        } catch (e) {}
      }
    } catch (sendError) {
      console.error("Lỗi gửi FCM:", sendError);
      return res.status(500).json({ success: false, error: sendError.message });
    }

    console.log(
      `✅ Đã gửi: ${successCount} thành công, ${failureCount} thất bại`,
    );

    res.json({
      success: true,
      sent: successCount,
      failed: failureCount,
      total: allTokens.length,
    });
  } catch (error) {
    console.error("❌ Lỗi server:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ======================================================
// API: KIỂM TRA SERVER ĐANG CHẠY
// GET /
// ======================================================
app.get("/", (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:40px;background:#0f0f1a;color:#f0f0f0;">
        <h1>✅ Chat Notification Server</h1>
        <p>Server đang chạy bình thường.</p>
        <p><b>Endpoint:</b> POST /api/notify</p>
        <p>Thời gian: ${new Date().toLocaleString("vi-VN")}</p>
      </body>
    </html>
  `);
});

// ======================================================
// KHỞI ĐỘNG SERVER
// ======================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy trên port ${PORT}`);
  console.log(`📡 Endpoint: http://localhost:${PORT}/api/notify`);
});
