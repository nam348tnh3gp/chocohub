/*
 * chocohub_esp32_miner.ino
 *
 * ChocoHub SHA-256 miner for ESP32 / ESP32-S2 / ESP32-S3 / ESP32-C3.
 *
 * ─── SETUP ────────────────────────────────
 *
 * 1. Install ESP32 board package in Arduino IDE:
 *      File > Preferences > Board Manager URLs:
 *        https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
 *      Tools > Board > Board Manager > search "esp32" > Install
 *
 * 2. Edit the CONFIGURATION section below:
 *      - WIFI_SSID / WIFI_PASS  — your WiFi credentials
 *      - SERVER_URL             — ChocoHub server URL
 *      - WORKER_NAME            — your ChocoHub username
 *      - WORKER_PIN             — your ChocoHub PIN (leave "" if no PIN)
 *
 * 3. Select your board:
 *      Tools > Board > ESP32 Arduino > ESP32 Dev Module
 *        (or ESP32-S2/S3/C3 Dev Module for those variants)
 *
 * 4. Select your port and Upload.
 *
 * ─── MULTI-NODE SETUP ──────────────────────────────────
 *
 * Each ESP32 auto-generates a unique INSTANCE_ID from its MAC address.
 * The server tracks each node separately, so you can run multiple ESP32s
 * on the same account. Each node gets its own difficulty and job queue.
 *
 * To override the auto-generated ID, uncomment and edit INSTANCE_ID below.
 *
 * ─── EXPECTED SERIAL OUTPUT ────────────────────────────────
 *
 *   [BOOT] ChocoHub ESP32 Miner v2.0
 *   [BOOT] Chip: ESP32 | Rev: 3 | Cores: 2 | Flash: 4 MB
 *   [BOOT] Free heap: 280 KB
 *   [BOOT] Node ID: esp32_AABBCCDDEEFF
 *   [WIFI] Connecting to MyNetwork...
 *   [WIFI] Connected! IP: 192.168.1.42 | RSSI: -45 dBm
 *   [AUTH] OK — user123 | token expires in 3600s
 *   [JOB] Received: a1b2c3d4 | diff 1200 | target 0000...
 *   [MINE] 4523 H/s | nonce 28341 | free heap 268 KB
 *   [MINE] 4501 H/s | nonce 56102 | free heap 268 KB
 *   [FOUND] nonce=81234 hash=000000a3f2...
 *   [SUBMIT] Accepted! +0.05 CC (total: 3)
 *
 * ─── TROUBLESHOOTING ────────────────────────────────────
 *
 * [WIFI] FAILED — check SSID/password, move closer to router
 * [AUTH] Server returned 401 — check WORKER_NAME and WORKER_PIN
 * [FETCH] Server returned 429 — too many requests, increase POLL_INTERVAL
 * [REJECT] ... — nonce was invalid (stale job?), will retry
 * [MINE] Low hashrate — normal for ESP32 (~20-40 kH/s SHA-256)
 * [WARN] Free heap below 20 KB — memory pressure, restart device
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "mbedtls/sha256.h"

// ─── CONFIGURATION ─────────────────────────────────
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASS     = "YOUR_WIFI_PASS";
const char* SERVER_URL    = "https://chocohub-r011.onrender.com";
const char* WORKER_NAME   = "yourchocohubuser";
const char* WORKER_PIN    = "your chocohub Pin";
const int   POLL_INTERVAL = 5;        // seconds between job requests

// Uncomment to override auto-generated node ID (default: esp32_<MAC>)
// const char* INSTANCE_ID = "esp32_custom_name";

// ─── DEVICE TYPE (auto-detected, do not change) ─────────────────────
const char* DEVICE_TYPE = "embedded_esp32";

// ─── FIRMWARE INFO ────────────────────────────────
const char* FW_VERSION = "2.0";

// ─── RUNTIME STATE ────────────────────────────────
String jobId      = "";
String lastHash   = "";
String targetHex  = "";
float  difficulty = 0;
float  reward     = 0;
bool   jobActive  = false;

unsigned long totalHashes = 0;
unsigned long blocksFound = 0;
unsigned long startTime   = 0;
unsigned long jobStart    = 0;
float currentHashrate     = 0;
String jwtToken   = "";
String nodeId     = "";
String chipModel  = "";

// ─── LOGGING ────────────────────────────────
unsigned long uptimeSec() {
  return (millis() - startTime) / 1000;
}

void log(const char* tag, const char* fmt, ...) {
  char buf[256];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  Serial.printf("[%05lu] [%s] %s\n", uptimeSec(), tag, buf);
}

// ─── CHIP DETECTION ─────────────────────────────────
void detectChip() {
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  chipModel = "ESP32-S3";
#elif defined(CONFIG_IDF_TARGET_ESP32S2)
  chipModel = "ESP32-S2";
#elif defined(CONFIG_IDF_TARGET_ESP32C3)
  chipModel = "ESP32-C3";
#elif defined(CONFIG_IDF_TARGET_ESP32C6)
  chipModel = "ESP32-C6";
#else
  chipModel = "ESP32";
#endif

  // Build node ID from MAC address for unique multi-node identification
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char macStr[13];
  snprintf(macStr, sizeof(macStr), "%02X%02X%02X%02X%02X%02X",
           mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

#ifdef INSTANCE_ID
  nodeId = String(INSTANCE_ID);
#else
  nodeId = "esp32_" + String(macStr);
#endif
}

// ─── SHA-256 ────────────────────────────────
void sha256_hex(const char* input, size_t inputLen, char output[65]) {
  uint8_t hash[32];
  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  mbedtls_sha256_starts(&ctx, 0);
  mbedtls_sha256_update(&ctx, (const uint8_t*)input, inputLen);
  mbedtls_sha256_finish(&ctx, hash);
  mbedtls_sha256_free(&ctx);
  for (int i = 0; i < 32; i++) {
    sprintf(output + i * 2, "%02x", hash[i]);
  }
  output[64] = '\0';
}

// ─── WIFI ────────────────────────────────────────────────────────────────────
void connectWiFi() {
  log("WIFI", "Connecting to %s ...", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    log("WIFI", "Connected! IP: %s | RSSI: %d dBm",
        WiFi.localIP().toString().c_str(), WiFi.RSSI());
  } else {
    log("WIFI", "FAILED after %d attempts! Restarting...", attempts);
    ESP.restart();
  }
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
int httpPost(const char* url, const char* body, String& resp, const char* auth = nullptr) {
  HTTPClient http;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  if (auth) {
    http.addHeader("Authorization", auth);
  }
  http.setTimeout(10000);
  int code = http.POST((uint8_t*)body, strlen(body));
  if (code > 0) resp = http.getString();
  http.end();
  return code;
}

// ─── AUTH ────────────────────────────────────
bool authenticate() {
  if (strlen(WORKER_PIN) == 0) {
    log("AUTH", "No PIN configured, skipping authentication");
    return true;
  }

  String body = "{\"username\":\"" + String(WORKER_NAME)
    + "\",\"pin\":\"" + String(WORKER_PIN)
    + "\",\"device_type\":\"" + DEVICE_TYPE
    + "\",\"instance_id\":\"" + nodeId + "\"}";

  String url = String(SERVER_URL) + "/auth";
  String resp;
  int code = httpPost(url.c_str(), body.c_str(), resp);

  if (code != 200) {
    log("AUTH", "Server returned %d — continuing without auth", code);
    return true;
  }

  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, resp) || doc["status"] != "success") {
    log("AUTH", "Parse failed or status != success — continuing without auth");
    return true;
  }

  jwtToken = doc["token"].as<String>();
  log("AUTH", "OK — %s | token %d chars", WORKER_NAME, jwtToken.length());
  return true;
}

// ─── FETCH JOB ────────────────────────────────
bool fetchJob() {
  String body = "{\"worker_name\":\"" + String(WORKER_NAME)
    + "\",\"instance_id\":\"" + nodeId
    + "\",\"device_type\":\"" + DEVICE_TYPE + "\"}";

  String url = String(SERVER_URL) + "/get_job";
  String resp;
  int code = httpPost(url.c_str(), body.c_str(), resp);

  if (code != 200) {
    log("FETCH", "Server returned %d", code);
    return false;
  }

  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, resp)) {
    log("FETCH", "JSON parse failed");
    return false;
  }

  jobId      = doc["job_id"].as<String>();
  if (jobId.length() == 0) jobId = doc["bounty_id"].as<String>();
  lastHash   = doc["prev_hash"].as<String>();
  if (lastHash.length() == 0) lastHash = doc["last_hash"].as<String>();
  targetHex  = doc["target_hex"].as<String>();
  difficulty = doc["difficulty"].as<float>();
  reward     = doc["reward"].as<float>();

  if (jobId.length() == 0 || lastHash.length() != 64 || targetHex.length() != 64) {
    log("FETCH", "Incomplete job data — id=%d last=%d target=%d",
        jobId.length(), lastHash.length(), targetHex.length());
    return false;
  }

  jobStart = millis();
  jobActive = true;
  log("JOB", "Received: %s | diff %.0f | reward %.4f CC",
      jobId.c_str(), difficulty, reward);
  return true;
}

// ─── SUBMIT SOLUTION ────────────────────────────────
bool submitSolution(const char* nonceStr, const char* hashHex) {
  String body = "{\"bounty_id\":\"" + jobId
    + "\",\"nonce\":\"" + nonceStr
    + "\",\"worker_name\":\"" + WORKER_NAME
    + "\",\"instance_id\":\"" + nodeId
    + "\",\"device_type\":\"" + DEVICE_TYPE
    + "\",\"hashrate_reported\":" + String((int)currentHashrate) + "}";

  String url = String(SERVER_URL) + "/submit_solution";
  String auth = jwtToken.length() > 0 ? ("Bearer " + jwtToken) : "";
  String resp;

  delay(10);
  yield();

  if (WiFi.status() != WL_CONNECTED) {
    log("SUBMIT", "WiFi lost, reconnecting...");
    connectWiFi();
  }

  int code = httpPost(url.c_str(), body.c_str(), resp,
                      auth.length() > 0 ? auth.c_str() : nullptr);

  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, resp)) {
    log("SUBMIT", "Response parse failed (HTTP %d)", code);
    return false;
  }

  if (doc["status"] == "success") {
    blocksFound++;
    float elapsed = (millis() - jobStart) / 1000.0;
    log("SUBMIT", "Accepted! +%f CC (total: %lu, solve time: %.1fs)",
        reward, blocksFound, elapsed);
    return true;
  } else {
    const char* msg = doc["message"] | "no message";
    log("REJECT", "%s", msg);
    return false;
  }
}

// ─── MINE ─────────────────────────────────
void mineJob() {
  char inputBuf[200];
  char nonceStr[21];
  char hashHex[65];

  // Server hashes: SHA256(prev_hash + nonce(20) + worker_name:instance_id)
  String diffKey = String(WORKER_NAME) + ":" + nodeId;
  int dkLen = diffKey.length();

  log("MINE", "Starting job %s | diff %.0f | key %s", jobId.c_str(), difficulty, diffKey.c_str());

  uint32_t nonce = 0;
  uint32_t lastPrint = millis();
  unsigned long batchStart = millis();

  while (jobActive) {
    sprintf(nonceStr, "%020u", nonce);
    memcpy(inputBuf, lastHash.c_str(), 64);
    memcpy(inputBuf + 64, nonceStr, 20);
    memcpy(inputBuf + 84, diffKey.c_str(), dkLen);
    size_t totalLen = 84 + dkLen;

    sha256_hex(inputBuf, totalLen, hashHex);
    totalHashes++;
    nonce++;

    if (strcmp(hashHex, targetHex.c_str()) < 0) {
      log("FOUND", "nonce=%u hash=%s", nonce - 1, hashHex);
      if (!submitSolution(nonceStr, hashHex)) {
        log("MINE", "Solution rejected, continuing...");
      }
      jobActive = false;
      return;
    }

    if (millis() - lastPrint > 5000) {
      float elapsed = (millis() - batchStart) / 1000.0;
      currentHashrate = nonce / elapsed;
      log("MINE", "%.0f H/s | nonce %lu | hashes %lu | heap %lu KB",
          currentHashrate, nonce, totalHashes, ESP.getFreeHeap() / 1024);
      lastPrint = millis();
    }

    if (nonce % 1000 == 0) {
      yield();

      // Memory guard
      if (ESP.getFreeHeap() < 20000) {
        log("WARN", "Free heap %lu KB — memory pressure!", ESP.getFreeHeap() / 1024);
      }

      // WiFi guard
      if (WiFi.status() != WL_CONNECTED) {
        log("WIFI", "Connection lost! Reconnecting...");
        connectWiFi();
      }
    }
  }
}

// ─── SETUP ───────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  delay(500);

  detectChip();

  Serial.println();
  Serial.println("========================================");
  Serial.printf("  ChocoHub ESP32 Miner v%s\n", FW_VERSION);
  Serial.printf("  Chip: %s | Cores: %d | Flash: %d KB\n",
                chipModel.c_str(), ESP.getChipCores(), ESP.getFlashChipSize() / 1024);
  Serial.printf("  Device: %s\n", DEVICE_TYPE);
  Serial.printf("  Node: %s\n", nodeId.c_str());
  Serial.println("========================================");
  Serial.println();

  log("BOOT", "Chip: %s | Rev: %d | Cores: %d | Flash: %d KB",
      chipModel.c_str(), ESP.getChipRevision(), ESP.getChipCores(),
      ESP.getFlashChipSize() / 1024);
  log("BOOT", "Free heap: %lu KB", ESP.getFreeHeap() / 1024);
  log("BOOT", "Node ID: %s", nodeId.c_str());
  log("BOOT", "Device type: %s", DEVICE_TYPE);

  startTime = millis();
  connectWiFi();
  authenticate();
}

// ─── LOOP ────────────────────────────────────────────────────────────────────
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (fetchJob()) {
    mineJob();
  } else {
    log("IDLE", "No job, retrying in %ds...", POLL_INTERVAL);
  }

  delay(POLL_INTERVAL * 1000);
}
