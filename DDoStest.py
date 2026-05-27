import requests
import threading
import time
import sys
from collections import defaultdict

# ========== HÀM TƯƠNG TÁC ==========
def input_int(prompt, default=None):
    while True:
        try:
            val = input(prompt)
            if val.strip() == "" and default is not None:
                return default
            return int(val)
        except ValueError:
            print("Vui lòng nhập số nguyên.")

def input_float(prompt, default=None):
    while True:
        try:
            val = input(prompt)
            if val.strip() == "" and default is not None:
                return default
            return float(val)
        except ValueError:
            print("Vui lòng nhập số thực.")

def input_str(prompt, default=None):
    val = input(prompt)
    if val.strip() == "" and default is not None:
        return default
    return val.strip()

def main():
    print("\n=== LOAD TEST SCRIPT (CHỈ DÙNG TRÊN SERVER CỦA BẠN) ===\n")
    url = input_str("URL cần test (vd: http://localhost:3000/api/test): ")
    method = input_str("Method (GET/POST): ", "GET").upper()
    threads = input_int("Số luồng (threads): ", 50)
    total_requests = input_int("Tổng số request (0 = không giới hạn, dừng bằng Ctrl+C): ", 0)
    delay = input_float("Delay giữa các request (giây, 0 = không delay): ", 0.0)
    use_token = input_str("Có dùng JWT token? (y/n): ", "n").lower() == 'y'
    token = ""
    if use_token:
        token = input_str("Nhập token (Bearer ...): ")
    post_data_str = input_str("Dữ liệu POST (JSON, nếu có, vd: {\"to_username\":\"test\",\"amount\":0.001}): ", "{}")
    post_data = None
    if post_data_str.strip() and post_data_str != "{}":
        import json
        try:
            post_data = json.loads(post_data_str)
        except:
            print("JSON không hợp lệ, bỏ qua dữ liệu POST.")
            post_data = None

    # Header
    headers = {"User-Agent": "Mozilla/5.0"}
    if use_token and token:
        if token.startswith("Bearer "):
            headers["Authorization"] = token
        else:
            headers["Authorization"] = f"Bearer {token}"

    # Biến toàn cục
    stop_flag = False
    request_count = 0
    success_count = 0
    rate_limit_count = 0
    other_error_count = 0
    status_counter = defaultdict(int)
    lock = threading.Lock()

    def make_request():
        nonlocal request_count, success_count, rate_limit_count, other_error_count
        try:
            if method == "GET":
                resp = requests.get(url, headers=headers, timeout=10)
            else:
                resp = requests.post(url, json=post_data, headers=headers, timeout=10)
            with lock:
                request_count += 1
                status_counter[resp.status_code] += 1
                if resp.status_code == 200:
                    success_count += 1
                elif resp.status_code == 429:
                    rate_limit_count += 1
                else:
                    other_error_count += 1
                # In tiến độ sau mỗi 100 request (không spam)
                if request_count % 100 == 0:
                    print(f"[*] Đã gửi {request_count} request... (200: {success_count}, 429: {rate_limit_count}, khác: {other_error_count})")
        except Exception as e:
            with lock:
                request_count += 1
                other_error_count += 1
                print(f"[!] Lỗi kết nối: {e}")

    def worker(thread_id):
        while not stop_flag:
            make_request()
            if delay > 0:
                time.sleep(delay)

    print(f"\nBắt đầu gửi request với {threads} luồng...")
    if total_requests > 0:
        print(f"Sẽ dừng sau {total_requests} request.")
    else:
        print("Không giới hạn request, dừng bằng Ctrl+C.")
    print("Nhấn Ctrl+C để dừng sớm.\n")

    start_time = time.time()
    thread_list = []
    for i in range(threads):
        t = threading.Thread(target=worker, args=(i,))
        t.daemon = True
        t.start()
        thread_list.append(t)

    # Giám sát số lượng request hoặc chờ Ctrl+C
    try:
        while True:
            time.sleep(0.5)
            if total_requests > 0 and request_count >= total_requests:
                print(f"\nĐã đạt {total_requests} request, dừng...")
                break
    except KeyboardInterrupt:
        print("\nNgười dùng dừng script.")

    stop_flag = True
    for t in thread_list:
        t.join(timeout=1)

    elapsed = time.time() - start_time
    print("\n=== KẾT QUẢ ===")
    print(f"URL: {url}")
    print(f"Method: {method}")
    print(f"Số luồng: {threads}")
    print(f"Tổng request: {request_count}")
    print(f"Thành công (200): {success_count}")
    print(f"Rate limit (429): {rate_limit_count}")
    print(f"Lỗi khác: {other_error_count}")
    print("Phân bố mã trạng thái:")
    for code, count in sorted(status_counter.items()):
        print(f"  {code}: {count}")
    if elapsed > 0:
        print(f"Thời gian: {elapsed:.2f} giây")
        print(f"Request/giây: {request_count / elapsed:.2f}")

if __name__ == "__main__":
    main()
