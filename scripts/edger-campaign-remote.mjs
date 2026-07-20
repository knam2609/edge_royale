#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REGION = process.env.AWS_REGION ?? "ap-southeast-2";
const DEFAULT_STACK = "edge-royale-edger-campaign";
const DEFAULT_CAMPAIGN_INPUT =
  process.env.EDGER_CAMPAIGN_INPUT_URI ??
  "s3://edge-royale-edger-904869824856-ap-southeast-2/campaigns/20260718-v2-first/campaign-input";
const PLAYWRIGHT_AL2023_PACKAGES = [
  "alsa-lib",
  "at-spi2-atk",
  "atk",
  "at-spi2-core",
  "cairo",
  "cups-libs",
  "dbus-libs",
  "libdrm",
  "mesa-libgbm",
  "glib2",
  "nspr",
  "nss",
  "pango",
  "libX11",
  "libxcb",
  "libXcomposite",
  "libXdamage",
  "libXext",
  "libXfixes",
  "libxkbcommon",
  "libXrandr",
  "fontconfig",
  "freetype",
  "liberation-fonts",
  "google-noto-emoji-color-fonts",
];

function parseArgs(argv) {
  const parsed = {
    command: argv[0] ?? "status",
    region: DEFAULT_REGION,
    stack: DEFAULT_STACK,
    campaignUri: DEFAULT_CAMPAIGN_INPUT.replace(/\/campaign-input\/?$/, ""),
    corpusStore:
      process.env.EDGER_CORPUS_STORE ??
      "s3://edge-royale-edger-904869824856-ap-southeast-2/corpus",
    gitSha: null,
    instanceId: null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--region" && argv[index + 1]) {
      parsed.region = argv[++index];
    } else if (arg === "--stack" && argv[index + 1]) {
      parsed.stack = argv[++index];
    } else if (arg === "--campaign-uri" && argv[index + 1]) {
      parsed.campaignUri = argv[++index].replace(/\/+$/, "");
    } else if (arg === "--corpus-store" && argv[index + 1]) {
      parsed.corpusStore = argv[++index].replace(/\/+$/, "");
    } else if (arg === "--git-sha" && argv[index + 1]) {
      parsed.gitSha = argv[++index];
    } else if (arg === "--instance-id" && argv[index + 1]) {
      parsed.instanceId = argv[++index];
    }
  }
  parsed.gitSha ??= git(["rev-parse", "HEAD"]).trim();
  return parsed;
}

function aws(args, { region = DEFAULT_REGION, encoding = "utf8" } = {}) {
  return execFileSync("aws", [...args, "--region", region], {
    encoding,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function awsJson(args, options) {
  return JSON.parse(aws([...args, "--output", "json"], options));
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function stackOutputs(args) {
  const stack = awsJson([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    args.stack,
  ], args);
  return Object.fromEntries(
    stack.Stacks[0].Outputs.map((output) => [
      output.OutputKey,
      output.OutputValue,
    ]),
  );
}

function campaignId(campaignUri) {
  return campaignUri.split("/").filter(Boolean).at(-1);
}

function findInstances(args) {
  const response = awsJson([
    "ec2",
    "describe-instances",
    "--filters",
    `Name=tag:campaign,Values=${campaignId(args.campaignUri)}`,
    `Name=tag:campaign-git-sha,Values=${args.gitSha}`,
    "Name=instance-state-name,Values=pending,running,stopping,stopped",
  ], args);
  return response.Reservations.flatMap((reservation) => reservation.Instances);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSsm(instanceId, args) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = awsJson([
      "ssm",
      "describe-instance-information",
      "--filters",
      `Key=InstanceIds,Values=${instanceId}`,
    ], args);
    if (
      response.InstanceInformationList.some(
        (information) =>
          information.InstanceId === instanceId &&
          information.PingStatus === "Online",
      )
    ) {
      return;
    }
    await delay(10_000);
  }
  throw new Error(`instance ${instanceId} did not become SSM-online within 15 minutes`);
}

export function bootstrapCommands(args) {
  const quotedCampaign = JSON.stringify(args.campaignUri);
  const quotedCorpus = JSON.stringify(args.corpusStore);
  const quotedSha = JSON.stringify(args.gitSha);
  return [
    "set -euo pipefail",
    [
      "dnf install -y",
      "git jq nodejs20 nodejs20-npm python3.11 python3.11-pip time",
      ...PLAYWRIGHT_AL2023_PACKAGES,
    ].join(" "),
    "alternatives --set node /usr/bin/node-20 || true",
    "alternatives --set npm /usr/bin/npm-20 || true",
    "rm -rf /opt/edge_royale",
    "git clone https://github.com/knam2609/edge_royale.git /opt/edge_royale",
    "cd /opt/edge_royale",
    `git checkout --detach ${quotedSha}`,
    `test "$(git rev-parse HEAD)" = ${quotedSha}`,
    "npm ci",
    "rm -rf /opt/edge_royale_venv",
    "python3.11 -m venv /opt/edge_royale_venv",
    "source /opt/edge_royale_venv/bin/activate",
    "pip install --upgrade pip",
    "pip install -r requirements-edger-training.txt",
    "npx playwright install chromium",
    "mkdir -p /var/log/edge-royale",
    "set +e",
    [
      "AWS_REGION=ap-southeast-2",
      `EDGER_CAMPAIGN_URI=${quotedCampaign}`,
      `EDGER_CORPUS_STORE=${quotedCorpus}`,
      "EDGER_REFERENCE_HARDWARE=aws-c7g.4xlarge-ap-southeast-2",
      "node scripts/edger-production-campaign.mjs",
      "2>&1",
      "| tee /var/log/edge-royale/campaign.log",
    ].join(" "),
    "campaign_status=${PIPESTATUS[0]}",
    `aws s3 cp /var/log/edge-royale/campaign.log ${quotedCampaign}/logs/remote-campaign.log --only-show-errors`,
    "shutdown -h now",
    "exit ${campaign_status}",
  ];
}

async function launch(args) {
  const existing = findInstances(args);
  if (existing.length > 0) {
    throw new Error(
      `campaign already has non-terminal instance ${existing[0].InstanceId}`,
    );
  }
  const outputs = stackOutputs(args);
  const imageId = aws([
    "ssm",
    "get-parameter",
    "--name",
    "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64",
    "--query",
    "Parameter.Value",
    "--output",
    "text",
  ], args).trim();
  const userData = [
    "#!/bin/bash",
    "systemd-run --unit=edge-royale-edger-safety-shutdown --on-active=24h /usr/sbin/shutdown -h now",
    "systemctl enable --now amazon-ssm-agent",
  ].join("\n");
  const tags = [
    { Key: "Name", Value: "edge-royale-edger-campaign" },
    { Key: "project", Value: "edge-royale" },
    { Key: "workload", Value: "edger-campaign" },
    { Key: "campaign", Value: campaignId(args.campaignUri) },
    { Key: "campaign-git-sha", Value: args.gitSha },
  ];
  const response = awsJson([
    "ec2",
    "run-instances",
    "--image-id",
    imageId,
    "--instance-type",
    "c7g.4xlarge",
    "--iam-instance-profile",
    `Name=${outputs.InstanceProfileName}`,
    "--subnet-id",
    outputs.SubnetId,
    "--security-group-ids",
    outputs.SecurityGroupId,
    "--associate-public-ip-address",
    "--instance-initiated-shutdown-behavior",
    "terminate",
    "--metadata-options",
    "HttpTokens=required,HttpEndpoint=enabled",
    "--block-device-mappings",
    JSON.stringify([{
      DeviceName: "/dev/xvda",
      Ebs: {
        VolumeSize: 200,
        VolumeType: "gp3",
        Encrypted: true,
        DeleteOnTermination: true,
      },
    }]),
    "--tag-specifications",
    JSON.stringify([
      { ResourceType: "instance", Tags: tags },
      { ResourceType: "volume", Tags: tags },
    ]),
    "--user-data",
    userData,
    "--count",
    "1",
  ], args);
  const instanceId = response.Instances[0].InstanceId;
  console.log(JSON.stringify({ status: "launching", instance_id: instanceId }, null, 2));
  aws(["ec2", "wait", "instance-running", "--instance-ids", instanceId], args);
  await waitForSsm(instanceId, args);
  const command = awsJson([
    "ssm",
    "send-command",
    "--instance-ids",
    instanceId,
    "--document-name",
    "AWS-RunShellScript",
    "--timeout-seconds",
    "86400",
    "--parameters",
    JSON.stringify({ commands: bootstrapCommands(args) }),
    "--comment",
    `Edge Royale Edger campaign ${campaignId(args.campaignUri)} at ${args.gitSha}`,
  ], args);
  console.log(JSON.stringify({
    status: "running",
    instance_id: instanceId,
    command_id: command.Command.CommandId,
    campaign_uri: args.campaignUri,
    git_sha: args.gitSha,
  }, null, 2));
}

function status(args) {
  const instances = findInstances(args).map((instance) => ({
    instance_id: instance.InstanceId,
    state: instance.State.Name,
    launched_at: instance.LaunchTime,
    instance_type: instance.InstanceType,
  }));
  let completedStages = [];
  try {
    completedStages = aws([
      "s3",
      "ls",
      `${args.campaignUri}/status/completed/`,
    ], args)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/).at(-1));
  } catch {
    completedStages = [];
  }
  console.log(JSON.stringify({
    campaign_uri: args.campaignUri,
    git_sha: args.gitSha,
    instances,
    completed_stages: completedStages,
  }, null, 2));
}

function terminate(args) {
  const instanceIds = args.instanceId
    ? [args.instanceId]
    : findInstances(args).map((instance) => instance.InstanceId);
  if (instanceIds.length === 0) {
    console.log(JSON.stringify({ status: "no-active-instance" }, null, 2));
    return;
  }
  aws(["ec2", "terminate-instances", "--instance-ids", ...instanceIds], args);
  console.log(JSON.stringify({
    status: "termination-requested",
    instance_ids: instanceIds,
  }, null, 2));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.command === "launch") {
      await launch(args);
    } else if (args.command === "status") {
      status(args);
    } else if (args.command === "terminate") {
      terminate(args);
    } else {
      throw new Error("command must be launch, status, or terminate");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
