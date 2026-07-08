#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "mbedtls/sha256.h"

const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASS     = "YOUR_WIFI_PASS";
const char* SERVER_URL    = "https://chocohub-r011.onrender.com";
const char* WORKER_NAME   = "yourchocohubuser";
const char* WORKER_PIN    = "your chocohub Pin";
const char* INSTANCE_ID   = "esp32";
const int   POLL_INTERVAL = 5;

String jobId     = "";
String lastHash  = "";
String targetHex = "";
float  difficulty = 0;
float  reward    = 0;
bool   jobActive = false;

unsigned long totalHashes  = 0;
unsigned long blocksFound  = 0;
unsigned long startTime    = 0;
String jwtToken = "";

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

void connectWiFi() {
  Serial.printf("[WIFI] Connecting to %s", WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WIFI] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WIFI] FAILED! Restarting...");
    ESP.restart();
  }
}

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

bool authenticate() {
  if (strlen(WORKER_PIN) == 0) return true;
  String body = "{\"username\":\"" + String(WORKER_NAME) + "\",\"pin\":\"" + String(WORKER_PIN) + "\"}";
  String url = String(SERVER_URL) + "/auth";
  String resp;
  int code = httpPost(url.c_str(), body.c_str(), resp);
  if (code != 200) {
    Serial.printf("[AUTH] Server returned %d (auth may not be required)\n", code);
    return true;
  }
  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, resp) || doc["status"] != "success") {
    Serial.println("[AUTH] Failed! Continuing without auth...");
    return true;
  }
  jwtToken = doc["token"].as<String>();
  Serial.printf("[AUTH] OK — %s\n", WORKER_NAME);
  return true;
}

bool fetchJob() {
  String body = "{\"worker_name\":\"" + String(WORKER_NAME) + "\",\"instance_id\":\"" + INSTANCE_ID + "\"}";
  String url = String(SERVER_URL) + "/get_job";
  String resp;
  int code = httpPost(url.c_str(), body.c_str(), resp);
  if (code != 200) {
    Serial.printf("[FETCH] Server returned %d\n", code);
    return false;
  }
  DynamicJsonDocument doc(2048);
  if (deserializeJson(doc, resp)) return false;
  jobId     = doc["job_id"].as<String>();
  if (jobId.length() == 0) jobId = doc["bounty_id"].as<String>();
  lastHash  = doc["prev_hash"].as<String>();
  if (lastHash.length() == 0) lastHash = doc["last_hash"].as<String>();
  targetHex = doc["target_hex"].as<String>();
  difficulty = doc["difficulty"].as<float>();
  reward    = doc["reward"].as<float>();
  if (jobId.length() == 0 || lastHash.length() != 64 || targetHex.length() != 64) {
    return false;
  }
  jobActive = true;
  return true;
}

bool submitSolution(const char* nonceStr, const char* hashHex) {
  String body = "{\"bounty_id\":\"" + jobId
    + "\",\"nonce\":\"" + nonceStr
    + "\",\"worker_name\":\"" + WORKER_NAME
    + "\",\"instance_id\":\"" + INSTANCE_ID + "\"}";
  String url = String(SERVER_URL) + "/submit_solution";
  String auth = jwtToken.length() > 0 ? ("Bearer " + jwtToken) : "";
  String resp;
  delay(10);
  yield();
  if (WiFi.status() != WL_CONNECTED) connectWiFi();
  httpPost(url.c_str(), body.c_str(), resp, auth.length() > 0 ? auth.c_str() : nullptr);
  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, resp)) return false;
  if (doc["status"] == "success") {
    blocksFound++;
    Serial.printf("[BLOCK] +%f CC (total: %lu)\n", reward, blocksFound);
    return true;
  } else {
    const char* msg = doc["message"] | "no message";
    Serial.printf("[REJECT] %s\n", msg);
    return false;
  }
}

void mineJob() {
  char inputBuf[200];
  char nonceStr[21];
  char hashHex[65];
  Serial.printf("[MINE] Job %s | diff %.0f | target %s\n", jobId.c_str(), difficulty, targetHex.c_str());
  uint32_t nonce = 0;
  uint32_t lastPrint = millis();
  unsigned long batchStart = millis();
  while (jobActive) {
    sprintf(nonceStr, "%020u", nonce);
    memcpy(inputBuf, lastHash.c_str(), 64);
    memcpy(inputBuf + 64, nonceStr, 20);
    int wLen = strlen(WORKER_NAME);
    memcpy(inputBuf + 84, WORKER_NAME, wLen);
    memcpy(inputBuf + 84 + wLen, ":" INSTANCE_ID, strlen(INSTANCE_ID) + 1);
    size_t totalLen = 84 + wLen + strlen(INSTANCE_ID) + 1;
    sha256_hex(inputBuf, totalLen, hashHex);
    totalHashes++;
    nonce++;
    if (strcmp(hashHex, targetHex.c_str()) < 0) {
      Serial.printf("[FOUND] nonce=%u hash=%s\n", nonce - 1, hashHex);
      if (!submitSolution(nonceStr, hashHex)) {
        Serial.println("[MINE] Solution rejected by server, continuing...");
      }
      jobActive = false;
      return;
    }
    if (millis() - lastPrint > 5000) {
      float elapsed = (millis() - batchStart) / 1000.0;
      float hr = (nonce) / elapsed;
      Serial.printf("[HR] %.0f H/s | nonce %lu | hashes %lu\n", hr, nonce, totalHashes);
      lastPrint = millis();
    }
    if (nonce % 1000 == 0) {
      yield();
      if (WiFi.status() != WL_CONNECTED) {
        Serial.println("[WIFI] Lost connection! Reconnecting...");
        connectWiFi();
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n========================================");
  Serial.println("  ChocoHub ESP32 Miner v1.0");
  Serial.println("  SHA-256 | Hardware accelerated");
  Serial.println("========================================\n");
  startTime = millis();
  connectWiFi();
  authenticate();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }
  Serial.printf("[INFO] Fetching job...\n");
  if (fetchJob()) {
    mineJob();
  } else {
    Serial.printf("[INFO] No job available, retrying in %ds...\n", POLL_INTERVAL);
  }
  delay(POLL_INTERVAL * 1000);
}
