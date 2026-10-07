import os
import sys
import webview

# Resolve base directories for both normal Python execution and PyInstaller (.exe) builds
BUNDLE_DIR = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BUNDLE_DIR)

from backend_api import BackendAPI

def main():
    api = BackendAPI()
    
    # Resolve the absolute path to the HTML file
    html_path = os.path.join(BUNDLE_DIR, 'web', 'index.html')
    
    # Create the modern desktop window rendering the HTML
    window = webview.create_window(
        'EduPulse Academic AI',
        url=html_path,
        js_api=api,
        width=1280,
        height=850,
        min_size=(1024, 768),
        background_color='#f8fafc'
    )
    
    # Enable DevTools only when EDUPULSE_DEBUG=1 is set
    debug_mode = os.environ.get('EDUPULSE_DEBUG', '0') == '1'
    webview.start(debug=debug_mode)

if __name__ == '__main__':
    main()
