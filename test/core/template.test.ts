import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  analyzeTemplate,
  extractParameterDefaults,
  extractScalarParameterDefaults,
  parseCfnTemplate,
  templatesEquivalent,
} from '../../src/core/template.js';

// tasks.md §4 T-03 の対応表:
//   FR-8-1(解析) / §6(解決可能 Sub) / §6(解決不能警告) / NFR-4(準備)
// 各行につき 1 つ以上のテストを用意し、テスト名に ID を明記する。

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/templates',
);

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), 'utf-8');
}

describe('parseCfnTemplate', () => {
  it('FR-8-1: 短縮タグ入り YAML と完全形 JSON(basic fixture)が同一結果になる', () => {
    const yamlResult = parseCfnTemplate(readFixture('basic.yaml'));
    const jsonResult = parseCfnTemplate(readFixture('basic.json'));
    expect(yamlResult).toEqual(jsonResult);
    expect(jsonResult).toEqual(JSON.parse(readFixture('basic.json')));
  });

  it('§6: 短縮タグ入り YAML と完全形 JSON(resolvable-sub-export fixture)が同一結果になる', () => {
    const yamlResult = parseCfnTemplate(
      readFixture('resolvable-sub-export.yaml'),
    );
    const jsonResult = parseCfnTemplate(
      readFixture('resolvable-sub-export.json'),
    );
    expect(yamlResult).toEqual(jsonResult);
  });

  it('§6: 短縮タグ入り YAML と完全形 JSON(dynamic fixture)が同一結果になる', () => {
    const yamlResult = parseCfnTemplate(readFixture('dynamic.yaml'));
    const jsonResult = parseCfnTemplate(readFixture('dynamic.json'));
    expect(yamlResult).toEqual(jsonResult);
  });

  it('FR-8-1: CFN 短縮タグをすべて完全形(Fn::X。Ref/Condition は例外)へ解決する', () => {
    const source = `
RefValue: !Ref MyResource
ConditionValue: !Condition SomeCondition
GetAttScalar: !GetAtt MyResource.Arn
GetAttNested: !GetAtt NestedStack.Outputs.Value
GetAttSeq: !GetAtt [MyResource, Arn]
ImportScalar: !ImportValue shared-name
ImportMap: !ImportValue
  Fn::Sub: '\${NetworkStack}-VpcId'
SubScalar: !Sub '\${AWS::StackName}-x'
SubSeq: !Sub
  - '\${Name}-x'
  - Name: foo
Base64Value: !Base64 hello
GetAZsValue: !GetAZs ''
JoinValue: !Join ['-', [a, b, !Ref MyResource]]
SelectValue: !Select [0, [a, b, c]]
SplitValue: !Split [',', 'a,b,c']
FindInMapValue: !FindInMap [RegionMap, us-east-1, AMI]
CidrValue: !Cidr ['10.0.0.0/16', 6, 5]
IfValue: !If [SomeCondition, a, b]
NotValue: !Not [!Equals [a, b]]
AndValue: !And [!Equals [a, b], !Equals [c, d]]
OrValue: !Or [!Equals [a, b], !Condition SomeCondition]
EqualsValue: !Equals [a, b]
`;

    expect(parseCfnTemplate(source)).toEqual({
      RefValue: { Ref: 'MyResource' },
      ConditionValue: { Condition: 'SomeCondition' },
      GetAttScalar: { 'Fn::GetAtt': ['MyResource', 'Arn'] },
      GetAttNested: { 'Fn::GetAtt': ['NestedStack', 'Outputs.Value'] },
      GetAttSeq: { 'Fn::GetAtt': ['MyResource', 'Arn'] },
      ImportScalar: { 'Fn::ImportValue': 'shared-name' },
      ImportMap: { 'Fn::ImportValue': { 'Fn::Sub': '${NetworkStack}-VpcId' } },
      SubScalar: { 'Fn::Sub': '${AWS::StackName}-x' },
      SubSeq: { 'Fn::Sub': ['${Name}-x', { Name: 'foo' }] },
      Base64Value: { 'Fn::Base64': 'hello' },
      GetAZsValue: { 'Fn::GetAZs': '' },
      JoinValue: { 'Fn::Join': ['-', ['a', 'b', { Ref: 'MyResource' }]] },
      SelectValue: { 'Fn::Select': [0, ['a', 'b', 'c']] },
      SplitValue: { 'Fn::Split': [',', 'a,b,c'] },
      FindInMapValue: { 'Fn::FindInMap': ['RegionMap', 'us-east-1', 'AMI'] },
      CidrValue: { 'Fn::Cidr': ['10.0.0.0/16', 6, 5] },
      IfValue: { 'Fn::If': ['SomeCondition', 'a', 'b'] },
      NotValue: { 'Fn::Not': [{ 'Fn::Equals': ['a', 'b'] }] },
      AndValue: {
        'Fn::And': [{ 'Fn::Equals': ['a', 'b'] }, { 'Fn::Equals': ['c', 'd'] }],
      },
      OrValue: {
        'Fn::Or': [
          { 'Fn::Equals': ['a', 'b'] },
          { Condition: 'SomeCondition' },
        ],
      },
      EqualsValue: { 'Fn::Equals': ['a', 'b'] },
    });
  });
});

describe('analyzeTemplate', () => {
  const ctx = { stackName: 'my-stack', region: 'us-east-1' };

  it('FR-8-1(解析): YAML 短縮タグ入りテンプレートから import / export 名を抽出する', () => {
    const result = analyzeTemplate(readFixture('basic.yaml'), ctx);
    expect(result.imports).toEqual(['shared-kms-key-arn']);
    expect(result.exports).toEqual(['basic-bucket-name']);
    expect(result.warnings).toEqual([]);
  });

  it('FR-8-1(解析): 同内容の JSON テンプレートからも同じ import / export が得られる', () => {
    const yamlResult = analyzeTemplate(readFixture('basic.yaml'), ctx);
    const jsonResult = analyzeTemplate(readFixture('basic.json'), ctx);
    expect(jsonResult).toEqual(yamlResult);
  });

  it('§6: 静的 Export 名と、${AWS::StackName}/${AWS::Region} のみの Fn::Sub は解決されて export になる', () => {
    const result = analyzeTemplate(readFixture('resolvable-sub-export.yaml'), {
      stackName: 'network-stack',
      region: 'ap-northeast-1',
    });
    expect(result.exports).toEqual([
      'network-stack-VpcId',
      'network-stack-ap-northeast-1-VpcId',
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('§6: 解決不能な動的合成の Export.Name は export とせず警告を返す', () => {
    const result = analyzeTemplate(readFixture('dynamic.yaml'), ctx);
    expect(result.exports).toEqual([]);
    const exportWarning = result.warnings.find((w) =>
      w.includes('DynamicExport'),
    );
    expect(exportWarning).toBeDefined();
  });

  it('§6: 解決不能な動的合成の Fn::ImportValue は import とせず警告を返す', () => {
    const result = analyzeTemplate(readFixture('dynamic.yaml'), ctx);
    expect(result.imports).toEqual([]);
    const importWarning = result.warnings.find((w) =>
      w.includes('Fn::ImportValue'),
    );
    expect(importWarning).toBeDefined();
    expect(result.warnings).toHaveLength(2);
  });

  it('FR-8-7(解決): String/Number Parameter の Ref と文字列 Fn::Sub を Default < 明示値で解決する', () => {
    const source = `
Parameters:
  Prefix:
    Type: String
    Default: default
  Revision:
    Type: Number
    Default: 7
  Empty:
    Type: String
    Default: fallback
Resources:
  ByRef:
    Type: Custom::Consumer
    Properties:
      Value:
        Fn::ImportValue:
          Ref: Prefix
  BySub:
    Type: Custom::Consumer
    Properties:
      Value:
        Fn::ImportValue:
          Fn::Sub: '\${Prefix}-\${Revision}-\${Empty}-\${AWS::Region}'
Outputs:
  ByRef:
    Value: value
    Export:
      Name: !Ref Prefix
  BySub:
    Value: value
    Export:
      Name: !Sub '\${AWS::StackName}-\${Prefix}-\${Revision}-\${Empty}'
`;
    const result = analyzeTemplate(source, {
      stackName: 'provider',
      region: 'ap-northeast-1',
      parameters: { Prefix: 'prod', Empty: '' },
    });

    expect(result.imports).toEqual(['prod', 'prod-7--ap-northeast-1']);
    expect(result.exports).toEqual(['prod', 'provider-prod-7-']);
    expect(result.warnings).toEqual([]);
  });

  it('FR-8-7(Fn::Sub escape): ${!Literal} は Parameter 参照せず Export / Import 名へ ${Literal} として残す', () => {
    const source = `
Parameters:
  Prefix:
    Type: String
    Default: default
Resources:
  Consumer:
    Type: Custom::Consumer
    Properties:
      Value:
        Fn::ImportValue:
          Fn::Sub: '\${!ImportedLiteral}-\${Prefix}'
Outputs:
  Shared:
    Value: value
    Export:
      Name:
        Fn::Sub: '\${!ExportedLiteral}-\${Prefix}'
`;

    const result = analyzeTemplate(source, {
      stackName: 'provider',
      region: 'ap-northeast-1',
      parameters: { Prefix: 'prod' },
    });

    expect(result.imports).toEqual(['${ImportedLiteral}-prod']);
    expect(result.exports).toEqual(['${ExportedLiteral}-prod']);
    expect(result.warnings).toEqual([]);
  });

  it('FR-8-7(未解決): 未確定・秘匿・未対応候補だけを位置と理由つきで除外し、静的候補は継続する', () => {
    const source = `
Parameters:
  Missing:
    Type: String
  Required:
    Type: String
    Default: default-must-not-be-used
  Secret:
    Type: String
    NoEcho: true
    Default: noecho-default-must-not-leak
  Structured:
    Type: String
    Default: [not, scalar]
  ListValue:
    Type: CommaDelimitedList
    Default: a,b
  SsmValue:
    Type: AWS::SSM::Parameter::Value<String>
    Default: /secret/path
Resources:
  Static:
    Type: Custom::Consumer
    Properties:
      Value: !ImportValue static-import
  Missing:
    Type: Custom::Consumer
    Properties:
      Value:
        Fn::ImportValue: { Ref: Missing }
  Required:
    Type: Custom::Consumer
    Properties:
      Value:
        Fn::ImportValue: { Ref: Required }
  ResourceRef:
    Type: Custom::Consumer
    Properties:
      Value:
        Fn::ImportValue: { Ref: Static }
  MappedSub:
    Type: Custom::Consumer
    Properties:
      Value:
        Fn::ImportValue:
          Fn::Sub:
            - '\${Alias}-name'
            - Alias: value
  Joined:
    Type: Custom::Consumer
    Properties:
      Value:
        Fn::ImportValue:
          Fn::Join: ['-', [a, b]]
Outputs:
  Static:
    Value: value
    Export:
      Name: static-export
  Secret:
    Value: value
    Export:
      Name: !Sub '\${Secret}-name'
  Structured:
    Value: value
    Export:
      Name: !Ref Structured
  List:
    Value: value
    Export:
      Name: !Ref ListValue
  Ssm:
    Value: value
    Export:
      Name: !Ref SsmValue
`;
    const result = analyzeTemplate(source, {
      ...ctx,
      parameters: {
        Required: '__REQUIRED__',
        Secret: 'configured-noecho-must-not-leak',
      },
    });

    expect(result.imports).toEqual(['static-import']);
    expect(result.exports).toEqual(['static-export']);
    expect(result.warnings).toHaveLength(9);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /\$\.Resources\.Missing\.Properties\.Value\.Fn::ImportValue.*neither an explicit value nor a Default/,
        ),
        expect.stringMatching(
          /\$\.Resources\.Required\.Properties\.Value\.Fn::ImportValue.*__REQUIRED__/,
        ),
        expect.stringMatching(
          /\$\.Resources\.ResourceRef\.Properties\.Value\.Fn::ImportValue.*Parameters/,
        ),
        expect.stringMatching(
          /\$\.Resources\.MappedSub\.Properties\.Value\.Fn::ImportValue.*variable-map form/,
        ),
        expect.stringMatching(
          /\$\.Resources\.Joined\.Properties\.Value\.Fn::ImportValue.*out of supported range/,
        ),
        expect.stringMatching(/Outputs\.Secret\.Export\.Name.*NoEcho/),
        expect.stringMatching(/Outputs\.Structured\.Export\.Name.*scalar/),
        expect.stringMatching(/Outputs\.List\.Export\.Name.*Type/),
        expect.stringMatching(/Outputs\.Ssm\.Export\.Name.*Type/),
      ]),
    );
    expect(result.warnings.join('\n')).not.toContain(
      'configured-noecho-must-not-leak',
    );
    expect(result.warnings.join('\n')).not.toContain(
      'noecho-default-must-not-leak',
    );
  });

  it('NFR-4(準備): Parameters から NoEcho: true / "true" のパラメータ名一覧を抽出する', () => {
    const result = analyzeTemplate(readFixture('noecho-params.yaml'), ctx);
    expect(result.noEchoParams).toEqual(['DbPassword', 'ApiKey']);
  });

  it('internal: import / export の重複は排除し、出現順を保つ', () => {
    const source = `
Resources:
  A:
    Type: AWS::SNS::Topic
    Properties:
      TopicArn: !ImportValue shared-topic-arn
  B:
    Type: AWS::SNS::Topic
    Properties:
      TopicArn: !ImportValue shared-topic-arn
  C:
    Type: AWS::SNS::Topic
    Properties:
      TopicArn: !ImportValue other-topic-arn
Outputs:
  First:
    Value: a
    Export:
      Name: export-a
  Second:
    Value: b
    Export:
      Name: export-b
`;
    const result = analyzeTemplate(source, ctx);
    expect(result.imports).toEqual(['shared-topic-arn', 'other-topic-arn']);
    expect(result.exports).toEqual(['export-a', 'export-b']);
  });

  it('NFR-4: NoEcho が false または未指定のパラメータは対象外', () => {
    const source = `
Parameters:
  Visible:
    Type: String
  ExplicitlyFalse:
    Type: String
    NoEcho: false
`;
    const result = analyzeTemplate(source, ctx);
    expect(result.noEchoParams).toEqual([]);
  });
});

describe('templatesEquivalent', () => {
  it('FR-10-3: YAML(短縮タグ)と JSON(完全形)が同一テンプレートであれば true を返す', () => {
    expect(
      templatesEquivalent(readFixture('basic.yaml'), readFixture('basic.json')),
    ).toBe(true);
  });

  it('FR-10-3: キー順・インデント・コメントの違いを無視して同値と判定する', () => {
    const a = `
Resources:
  A:
    Type: AWS::SNS::Topic
  B:
    Type: AWS::SQS::Queue
`;
    // 同じ内容だがキー順・書式が異なる
    const b = `
# comment should be ignored
Resources:
  B:
    Type: AWS::SQS::Queue
  A:
    Type: AWS::SNS::Topic
`;
    expect(templatesEquivalent(a, b)).toBe(true);
  });

  it('FR-10-3: 内容が異なるテンプレートは false と判定する', () => {
    const a = `
Resources:
  A:
    Type: AWS::SNS::Topic
`;
    const b = `
Resources:
  A:
    Type: AWS::SQS::Queue
`;
    expect(templatesEquivalent(a, b)).toBe(false);
  });

  it('internal: 配列の順序差は同値とみなさない(意味が変わりうるため)', () => {
    const a = `Values: [a, b]`;
    const b = `Values: [b, a]`;
    expect(templatesEquivalent(a, b)).toBe(false);
  });
});

describe('extractParameterDefaults', () => {
  it('FR-1-11(a)準備: Parameters Default を文字列化して抽出し Default なしは含めない', () => {
    const parsed = parseCfnTemplate(`
Parameters:
  Environment:
    Type: String
    Default: dev
  DesiredCount:
    Type: Number
    Default: 3
  Enabled:
    Type: String
    Default: true
  Required:
    Type: String
Resources: {}
`);

    expect(extractParameterDefaults(parsed)).toEqual({
      Environment: 'dev',
      DesiredCount: '3',
      Enabled: 'true',
    });
  });

  it('FR-1-11(a) fail-closed: 非 scalar Default を実効値として推測しない', () => {
    for (const defaultValue of [
      { Ref: 'OtherParameter' },
      ['a', 'b'],
      { nested: 'value' },
    ]) {
      expect(() =>
        extractParameterDefaults({
          Parameters: {
            Unsupported: { Type: 'String', Default: defaultValue },
          },
        }),
      ).toThrow(/Unsupported.*Default|Default.*Unsupported/);
    }
  });

  it('NFR-4(Default準備): redaction 用には scalar Default だけを抽出し非 scalar は無視する', () => {
    expect(
      extractScalarParameterDefaults({
        Parameters: {
          StringValue: { Type: 'String', Default: 'secret-value' },
          NumberValue: { Type: 'Number', Default: 42 },
          BooleanValue: { Type: 'String', Default: false },
          IntrinsicValue: {
            Type: 'String',
            Default: { Ref: 'OtherParameter' },
          },
          MissingValue: { Type: 'String' },
        },
      }),
    ).toEqual({
      StringValue: 'secret-value',
      NumberValue: '42',
      BooleanValue: 'false',
    });
  });
});
