import json
import boto3
import os
import pandas as pd
from io import BytesIO
from s3_upload import s3_upload
from openpyxl import Workbook

def generate_file_name_validation_file(bucket_name, tags, output_file_key):
    print(f"In generate_file_name_validation_file tags are: {tags}")
    
    required_keys = ["Pillar", "Data Entity", "Mock Number", "Source"]
    parent_file_name = tags.get("Parent File Name", "N/A")
    message = f"Initial Upload File not expected for file {parent_file_name} based on tag values:"
    tag_data = [(key, tags.get(key, "N/A")) for key in required_keys]
    
    output = BytesIO()
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Tags"
    sheet.append([message])
    sheet.append([])
    sheet.append(["Tag Key", "Tag Value"])
    for key, value in tag_data:
        sheet.append([key, value])
    workbook.save(output)
    output.seek(0)
    
    s3_upload(bucket_name, output_file_key, output.getvalue(), tags)
    return {"statusCode": 200, "message": f"Excel file uploaded to s3://{bucket_name}/{output_file_key}"}

def generate_header_validation_file(bucket_name, tags, output_file_key, comparison_results):
    print(f"In generate_header_validation_file tags are: {tags}")
    output_file = "/tmp/header_validation.xlsx"
    df = pd.DataFrame(comparison_results, columns=["Order Number", "CSV Header", "Database Header", "Exact Match"])
    df.to_excel(output_file, index=False)
    with open(output_file, "rb") as file:
        file_content = file.read()
    s3_upload(bucket_name, output_file_key, file_content, tags)
    print(f"Header validation file uploaded to s3://{bucket_name}/{output_file_key}")

def generate_file_expected_validation_file(bucket_name, tags, output_file_key):
    print(f"In generate_file_expected_validation_file tags are: {tags}")
    folder_name = os.path.basename(os.path.dirname(output_file_key))
    message = (f"File {folder_name} is not expected to be loaded. This could be because it was already loaded "
               "and no changes are expected or the file is out of scope.")
    output_file = "/tmp/expected_validation.txt"
    with open(output_file, "w") as file:
        file.write(message)
    with open(output_file, "rb") as file:
        file_content = file.read()
    s3_upload(bucket_name, output_file_key, file_content, tags)
    print(f"Expected validation file uploaded to s3://{bucket_name}/{output_file_key}")

def generate_conversion_file_upload_error_file(bucket_name, tags, output_file_key, error):
    print(f"In generate_conversion_file_upload_error_file tags are: {tags}")
    message = f"The following error occured while reading CSV file: {error}"
    output_file = "/tmp/csv_error_file.txt"
    with open(output_file, "w") as file:
        file.write(message)
    with open(output_file, "rb") as file:
        file_content = file.read()
    s3_upload(bucket_name, output_file_key, file_content, tags)
    print(f"CSV Read error file uploaded to s3://{bucket_name}/{output_file_key}")

def generate_load_file_param_count_error_file(bucket_name, tags, output_file_key, message):
    print(f"In generate_load_file_param_count_error_file tags are: {tags}")
    output_file = "/tmp/csv_param_count_error_file.txt"
    with open(output_file, "w") as file:
        file.write(message)
    with open(output_file, "rb") as file:
        file_content = file.read()
    s3_upload(bucket_name, output_file_key, file_content, tags)
    print(f"Param count error file uploaded to s3://{bucket_name}/{output_file_key}")

def generate_tsql_not_found_error_file(bucket_name, tags, output_file_key, message):
    print(f"In generate_tsql_not_found_error_file tags are: {tags}")
    output_file = "/tmp/tsql_not_found_error_file.txt"
    with open(output_file, "w") as file:
        file.write(message)
    with open(output_file, "rb") as file:
        file_content = file.read()
    s3_upload(bucket_name, output_file_key, file_content, tags)
    print(f"Tsql not found error file uploaded to s3://{bucket_name}/{output_file_key}")

def generate_insert_rows_error_file(bucket_name, tags, output_file_key, message):
    print(f"In generate_insert_rows_error_file tags are: {tags}")
    output_file = "/tmp/insert_rows_error_file.txt"
    with open(output_file, "w") as file:
        file.write(message)
    with open(output_file, "rb") as file:
        file_content = file.read()
    s3_upload(bucket_name, output_file_key, file_content, tags)
    print(f"Insert rows error file uploaded to s3://{bucket_name}/{output_file_key}")