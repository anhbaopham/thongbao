// ======================================================
// SERVER GỬI THÔNG BÁO FCM + TĂNG UNREAD
// Dùng sendEachForMulticast (HTTP v1 API)
// ======================================================

const express = require("express");
const admin = require("firebase-admin");
const cors = require("cors");

// ======================================================
// LOAD SERVICE ACCOUNT
// ======================================================
let serviceAccount = null;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  try {
    serviceAccount = JSON.parse(
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    );
    console.log("✅ Load service account từ ENV");
  } catch (e) {
    console.error("❌ ENV không hợp lệ:", e.message);
    process.exit(1);
  }
} else {
  try {
    serviceAccount = require("./serviceAccountKey.json");
    console.log("✅ Load service account từ file");
  } catch (e) {
    console.error("❌ Không tìm thấy service account");
    process.exit(1);
  }
}

if (serviceAccount.private_key && serviceAccount.private_key.includes("\\n")) {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  }),
);

app.use(express.json({ limit: "1mb" }));

// ======================================================
// API: GỬI THÔNG BÁO
// POST /api/notify
// ======================================================
app.post("/api/notify", async (req, res) => {
  try {
    const {
      chatId,
      chatType,
      senderNickname,
      senderUid,
      messageText,
      recipientUids,
    } = req.body;

    console.log("📨", {
      chatId,
      chatType,
      senderNickname,
      recipients: recipientUids ? recipientUids.length : 0,
    });

    if (
      !recipientUids ||
      !Array.isArray(recipientUids) ||
      recipientUids.length === 0
    ) {
      return res.json({ success: true, sent: 0, unread: 0 });
    }

    // ==========================================
    // 1. TĂNG UNREAD COUNT
    // ==========================================
    let unreadUpdated = 0;
    for (const uid of recipientUids) {
      if (uid === senderUid) continue;
      try {
        const unreadRef = db
          .collection("users")
          .doc(uid)
          .collection("unread")
          .doc(chatId);

        await db.runTransaction(async (tx) => {
          const doc = await tx.get(unreadRef);
          const count = doc.exists ? doc.data().count || 0 : 0;
          tx.set(unreadRef, { count: count + 1 }, { merge: true });
        });

        unreadUpdated++;
      } catch (e) {
        console.warn(`Unread fail cho ${uid}:`, e.message);
      }
    }

    // ==========================================
    // 2. LẤY TOKENS
    // ==========================================
    const allTokens = [];
    for (const uid of recipientUids) {
      if (uid === senderUid) continue;
      try {
        const tokensSnap = await db
          .collection("users")
          .doc(uid)
          .collection("tokens")
          .get();
        tokensSnap.forEach((doc) => {
          const token = doc.data().token;
          if (token) allTokens.push({ uid, token });
        });
      } catch (e) {}
    }

    if (allTokens.length === 0) {
      console.log("⚠️ Không có FCM token nào");
      return res.json({ success: true, sent: 0, unread: unreadUpdated });
    }

    const tokenStrings = allTokens.map((t) => t.token);

    // ==========================================
    // 3. BUILD MESSAGE (đúng format HTTP v1)
    // ==========================================
    const message = {
      notification: {
        title: senderNickname || "Tin nhắn mới",
        body: messageText || "Bạn có tin nhắn mới",
      },
      data: {
        chatId: String(chatId || ""),
        chatType: String(chatType || ""),
        senderUid: String(senderUid || ""),
        type: "new_message",
      },
      webpush: {
        notification: {
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          tag: String(chatId || "chat-msg"),
          renotify: true,
        },
        fcmOptions: {
          link: "/",
        },
      },
    };

    // ==========================================
    // 4. GỬI BẰNG sendEachForMulticast (HTTP v1 API)
    // ==========================================
    let successCount = 0;
    let failureCount = 0;

    try {
      const response = await admin.messaging().sendEachForMulticast({
        ...message,
        tokens: tokenStrings,
      });

      successCount = response.successCount;
      failureCount = response.failureCount;

      console.log(
        `📤 Kết quả: ${successCount} thành công / ${failureCount} thất bại`,
      );

      // Xoá token lỗi
      const invalidTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const err = resp.error;
          const errCode = err && err.code;
          console.warn(`Token ${idx} lỗi:`, errCode);

          if (
            errCode === "messaging/invalid-registration-token" ||
            errCode === "messaging/registration-token-not-registered" ||
            errCode === "messaging/invalid-argument"
          ) {
            invalidTokens.push(allTokens[idx]);
          }
        }
      });

      for (const { uid, token } of invalidTokens) {
        try {
          await db
            .collection("users")
            .doc(uid)
            .collection("tokens")
            .doc(token)
            .delete();
          console.log(`🗑 Đã xoá token lỗi của ${uid}`);
        } catch (e) {}
      }
    } catch (sendError) {
      console.error("❌ FCM send error:", sendError.message);
      failureCount = allTokens.length;
    }

    console.log(
      `✅ Sent: ${successCount}, Failed: ${failureCount}, Unread: ${unreadUpdated}`,
    );

    res.json({
      success: true,
      sent: successCount,
      failed: failureCount,
      unread: unreadUpdated,
      total: allTokens.length,
    });
  } catch (error) {
    console.error("❌ Server error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ======================================================
// API kiểm tra
// ======================================================
app.get("/", (req, res) => {
  res.send(`
    <html>
      <body style="font-family:sans-serif;padding:40px;background:#0f0f1a;color:#f0f0f0;">
        <h1>✅ Chat Notification Server</h1>
        <p>Server đang chạy.</p>
        <p>Endpoint: POST /api/notify</p>
        <p>Thời gian: ${new Date().toLocaleString("vi-VN")}</p>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server chạy port ${PORT}`);
  console.log(`📡 Endpoint: http://localhost:${PORT}/api/notify`);
});
