#!/bin/sh
set -eu
rm -f /tmp/queues-ready
python3 - <<'PY'
import os, json, boto3
sqs = boto3.client('sqs', endpoint_url='http://localhost:4566', region_name=os.environ['AWS_DEFAULT_REGION'])
dlq = sqs.create_queue(QueueName=os.environ['SQS_DLQ_NAME'], Attributes={'FifoQueue':'true'})['QueueUrl']
arn = sqs.get_queue_attributes(QueueUrl=dlq, AttributeNames=['QueueArn'])['Attributes']['QueueArn']
url = sqs.create_queue(QueueName=os.environ['SQS_QUEUE_NAME'], Attributes={'FifoQueue':'true'})['QueueUrl']
sqs.set_queue_attributes(QueueUrl=url, Attributes={'VisibilityTimeout':os.environ['SQS_VISIBILITY_TIMEOUT'], 'ReceiveMessageWaitTimeSeconds':'20', 'RedrivePolicy':json.dumps({'deadLetterTargetArn':arn,'maxReceiveCount':int(os.environ['SQS_MAX_RECEIVE_COUNT'])})})
PY
touch /tmp/queues-ready
