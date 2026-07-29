from pydrive2.auth import GoogleAuth
from pydrive2.drive import GoogleDrive
import os

gauth = GoogleAuth("settings.yaml")

if os.path.exists("mycreds.txt"):
    gauth.LoadCredentialsFile("mycreds.txt")

if gauth.credentials is None:
    print("First time login required...")
    gauth.LocalWebserverAuth()
    gauth.SaveCredentialsFile("mycreds.txt")

elif gauth.access_token_expired:
    print("Refreshing access token...")
    gauth.Refresh()
    gauth.SaveCredentialsFile("mycreds.txt")

else:
    print("Using saved credentials...")
    gauth.Authorize()

drive = GoogleDrive(gauth)

folder_id = "18pys1Pn4EHeycwWWvtj5StiqqFQTYTEs"

local_folder = r"C:\Users\Administrator\Documents\UiPath\Shopify_Scraper\Scrapped_Csv_Files"

uploaded = 0

for filename in os.listdir(local_folder):
    if filename.lower().endswith(".csv"):
        filepath = os.path.join(local_folder, filename)
        print(f"Uploading: {filename}")

        gfile = drive.CreateFile({
            "title": filename,
            "parents": [{"id": folder_id}]
        })

        gfile.SetContentFile(filepath)
        gfile.Upload()

        uploaded += 1
        print(f"✓ Uploaded: {filename}")

print(f"\nCompleted. Total uploaded: {uploaded}")