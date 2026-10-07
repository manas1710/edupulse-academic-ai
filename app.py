import os
os.environ["EDUPULSE_WEB_MODE"] = "1"
import traceback
import webbrowser
from threading import Timer
from flask import Flask, request, jsonify, send_from_directory, send_file, abort
from werkzeug.utils import secure_filename
from backend_api import BackendAPI

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(BASE_DIR, "web")
UPLOAD_DIR = os.path.join(BASE_DIR, "data", "uploads")
EXPORT_DIR = os.path.join(BASE_DIR, "data", "exports")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(EXPORT_DIR, exist_ok=True)

app = Flask(__name__, static_folder=WEB_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50 MB max upload

# Single shared backend API instance
api_instance = BackendAPI()


@app.route("/")
def serve_index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/api/rpc/<method_name>", methods=["POST"])
def handle_rpc(method_name):
    if not method_name or method_name.startswith("_"):
        return jsonify({"status": "error", "message": "Invalid API method"}), 400

    fn = getattr(api_instance, method_name, None)
    if not callable(fn):
        return jsonify({"status": "error", "message": f"Unknown API method: {method_name}"}), 404

    try:
        payload = request.get_json(silent=True) or {}
        args = payload.get("args", [])
        if not isinstance(args, list):
            args = [args]
        result = fn(*args)
        return jsonify(result)
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/upload", methods=["POST"])
def handle_upload():
    try:
        if "file" not in request.files:
            return jsonify({"status": "error", "message": "No file uploaded"}), 400

        uploaded_file = request.files["file"]
        if not uploaded_file or not uploaded_file.filename:
            return jsonify({"status": "cancelled"})

        action = request.form.get("action", "choose_file")
        faculty_id = request.form.get("faculty_id")
        if faculty_id is not None and str(faculty_id).strip() != "":
            try:
                faculty_id = int(faculty_id)
            except ValueError:
                pass
        else:
            faculty_id = None

        safe_name = secure_filename(uploaded_file.filename) or "uploaded_file"
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        saved_path = os.path.join(UPLOAD_DIR, safe_name)
        uploaded_file.save(saved_path)

        if action == "choose_file":
            return jsonify(api_instance.choose_file(filepath=saved_path))
        elif action == "upload_faculty_photo":
            return jsonify(api_instance.upload_faculty_photo(faculty_id, filepath=saved_path))
        elif action == "bulk_import_students":
            return jsonify(api_instance.bulk_import_students(faculty_id=faculty_id, filepath=saved_path))
        elif action == "restore_database":
            return jsonify(api_instance.restore_database(filepath=saved_path))
        else:
            return jsonify({"status": "error", "message": f"Unsupported upload action: {action}"}), 400
    except Exception as e:
        traceback.print_exc()
        return jsonify({"status": "error", "message": str(e)}), 500


@app.route("/api/download/<path:filename>", methods=["GET"])
def handle_download(filename):
    safe_base = os.path.basename(filename)
    if not safe_base:
        abort(404)

    # Check both _get_export_dir() and data/exports
    candidate_dirs = [
        api_instance._get_export_dir(),
        EXPORT_DIR
    ]
    for d in candidate_dirs:
        full_path = os.path.join(d, safe_base)
        if os.path.exists(full_path) and os.path.isfile(full_path):
            return send_file(full_path, as_attachment=True, download_name=safe_base)

    return jsonify({"status": "error", "message": "Requested file not found"}), 404


@app.route("/<path:AssetPath>")
def serve_static_assets(AssetPath):
    full_path = os.path.join(WEB_DIR, AssetPath)
    if os.path.exists(full_path) and os.path.isfile(full_path):
        return send_from_directory(WEB_DIR, AssetPath)
    return send_from_directory(WEB_DIR, "index.html")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    url = f"http://127.0.0.1:{port}"
    print(f"\n=======================================================", flush=True)
    print(f" EduPulse Academic AI Web Server is LIVE!", flush=True)
    print(f" Open in your browser: {url}", flush=True)
    print(f"=======================================================\n", flush=True)
    if not os.environ.get("RENDER") and not os.environ.get("RAILWAY_ENVIRONMENT"):
        Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="0.0.0.0", port=port, debug=False)
