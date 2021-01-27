'use strict';

const BbPromise = require('bluebird');
const _ = require('lodash');
const md5 = require('md5');

function getRuleRolePolicyResource(queueArn, roleRef) {
  return {
    "Type": "AWS::IAM::Policy",
    "Properties": {
      "PolicyDocument": {
        "Statement": [{
          "Action": "sqs:*",
          "Effect": "Allow",
          "Resource": queueArn
        }],
        "Version": "2012-10-17"
      },
      "PolicyName": "SQSPolicy",
      "Roles": [{
        "Ref": roleRef
      }]
    }
  }
}

function getRuleRoleResource(roleName, tags) {
  return {
    "Type": "AWS::IAM::Role",
    "Properties": {
      "RoleName": roleName,
      "AssumeRolePolicyDocument": {
        "Statement": [{
          "Action": "sts:AssumeRole",
          "Effect": "Allow",
          "Principal": {
            "Service": ["events.amazonaws.com", "sqs.amazonaws.com"]
          }
        }],
        "Version": "2012-10-17"
      },
      "Tags": tags,
    }
  };
}

function getRuleResource(queueArn, roleArn, prefix, rule) {
  const funcPath = _.get(rule, 'func', null);
  const funcArgs = _.get(rule, 'func_args', []);
  const funcKwargs = _.get(rule, 'func_kwargs', {});
  const expression = _.get(rule, 'expression', null);
  const isEnabled = _.get(rule, 'enabled', true);
  if (!funcPath || !expression) {
    return
  }
  const payload = {
    'task_path': funcPath,
    'args': funcArgs,
    'kwargs': funcKwargs,
  };
  const payloadId = md5(JSON.stringify(Object.assign({expression: expression}, payload)));
  const name = _.isEmpty(prefix) ? payloadId : `${prefix}-${payloadId}`;
  const groupId = md5(name);
  const task = JSON.stringify(
    Object.assign(
      {
        '__integration': 'scheduled',
        '__sws_version': 'v3',
        '__sws_worker': 'lambda',
      },
      payload
    )
  );
  const sqsTarget = {
    'Id': `${groupId}-sqs`,
    'Arn': queueArn,
    'SqsParameters': {
      "MessageGroupId": groupId
    },
    'Input': task
  };
  return {
    "Type": "AWS::Events::Rule",
    "Properties": {
      "Description": _.get(rule, 'desc', ''),
      "Name": name,
      "ScheduleExpression": expression,
      "RoleArn": roleArn,
      "State": isEnabled ? 'ENABLED' : 'DISABLED',
      "Targets": [
        sqsTarget
      ]
    }
  };
}

function updateSchedules() {
  const stage = _.get(
    this.serverless,
    'variables.options.stage',
    _.get(this.serverless, 'service.provider.stage', null)
  );
  this.options.schedules
    .filter(s =>
      !_.isEmpty(_.get(s, 'queueArn', '')) && !_.isEmpty(_.get(s, 'rules', []))
    )
    .map((s, index) => {
      const queueArn = _.get(s, 'queueArn', null);
      const tags = _.get(s, 'tags', []);
      const prefix = _.get(s, 'prefix', `${this.serverless.service.service}-${stage}-sws-schedule-${index}`);
      const roleName = `${prefix}-role`;
      const roleRef = _.camelCase(roleName);
      const roleArn = { 'Fn::GetAtt': [ roleRef, 'Arn' ] };
      const roleResource = getRuleRoleResource(roleName, tags);
      const policyName = `${prefix}-role-policy`;
      const policyRef = _.camelCase(policyName);
      const policyResource = getRuleRolePolicyResource(queueArn, roleRef);
      const rules = s.rules;
      const resources = {};
      resources[roleRef] = roleResource;
      resources[policyRef] = policyResource;
      rules.map(rule => {
        const r = getRuleResource(queueArn, roleArn, prefix, rule);
        const ref = _.camelCase(r["Properties"]["Name"]);
        resources[ref] = r;
        return r;
      });
      _.merge(this.serverless.service.provider.compiledCloudFormationTemplate.Resources, resources);
      console.log(this.serverless.service.provider.compiledCloudFormationTemplate.Resources);
    });
}

class ServerlessPlugin {
  get options() {
    return Object.assign(
      {
        schedules: []
      },
      (this.serverless.service.custom &&
        this.serverless.service.custom.sws) ||
      {}
    );
  }

  constructor(serverless) {
    this.serverless = serverless;
    this.servicePath = this.serverless.config.servicePath;

    const before = () => {
      console.log(this.serverless.service.provider.compiledCloudFormationTemplate.Resources);
      return BbPromise.bind(this)
        .then(updateSchedules)
    };

    this.hooks = {
      'before:deploy:deploy': before,
    };
  }
}

module.exports = ServerlessPlugin;
