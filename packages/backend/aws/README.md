# P0tion Coordinator Guide

## Steps

Follow these steps [here](https://hackmd.io/@ctrlc03/HysyJzPgn). Please consider the following:

1. Add the permission policies for the IAM user `AmazonSNSFullAccess`, `AWSLambda_FullAccess` and `IAMFullAccess`.
2. Remember to print all `terraform output` values and save them in `/packages/backend/.env` file.

## Errors

If you are getting the error `EntityAlreadyExists: Instance Profile p0tion_ec2_instance_profile already exists.` then run the following commands:

```bash

aws iam delete-instance-profile --instance-profile-name p0tion_ec2_instance_profile

aws iam list-instance-profiles

```

If you getting the error `Project does not exists or your account does not have account to it` then run the following:

```bash

firebase logout

firebase login

```

Reference [here](https://github.com/hashicorp/terraform/issues/3749).
