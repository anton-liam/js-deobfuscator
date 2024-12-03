import type * as t from '@babel/types'
import type { NodePath } from '@babel/traverse'
import traverse from '@babel/traverse'

import { generate } from '../ast-utils'
import { Decoder } from '../deobfuscate/decoder'
import type { ArrayRotator } from '../deobfuscate/array-rotator'
import prettier from 'prettier'
import  {functionExpression, blockStatement, callExpression, parenthesizedExpression, expressionStatement} from '@babel/types'

export async function findDecoderByArray(ast: t.Node, count: number = 100) {
  // 大数组 有可能是以函数形式包裹的
  let stringArray: {
    path: NodePath<t.Node>
    references: NodePath[]
    name: string
    length: number
  } | undefined
  // 乱序函数
  const rotators: (ArrayRotator | NodePath)[] = []
  // 解密器
  const decoders: Decoder[] = []

  traverse(ast, {
    ArrayExpression(path) {
      if (path.node.elements.length >= count) {
        const stringArrayDeclaration = path.findParent(p => p.isVariableDeclarator() || p.isFunctionDeclaration() || p.isExpressionStatement())

        if (!stringArrayDeclaration)
          return

        // if (!stringArrayDeclaration?.parentPath?.isProgram())
        // return

        let stringArrayName = ''
        let stringArrayPath
        if (stringArrayDeclaration.isVariableDeclarator()) {
          // var a = []
          stringArrayName = (stringArrayDeclaration.node.id as t.Identifier).name
          stringArrayPath = stringArrayDeclaration.parentPath

          // 可能会被在包裹一层
          const parent = stringArrayPath.findParent(p => p.isFunctionDeclaration())
          if (parent && parent.isFunctionDeclaration()) {
            stringArrayName = parent.node.id!.name
            stringArrayPath = parent
          }
        }
        else if (stringArrayDeclaration.isFunctionDeclaration()) {
          // function a(){ return []}
          stringArrayName = (stringArrayDeclaration.node.id as t.Identifier).name
          stringArrayPath = stringArrayDeclaration
        }
        else if (stringArrayDeclaration.isExpressionStatement()) {
          if (stringArrayDeclaration.node.expression.type === 'AssignmentExpression') {
            // a = []
            stringArrayName = (stringArrayDeclaration.node.expression.left as t.Identifier).name
            stringArrayPath = stringArrayDeclaration
          }
        }

        const binding = path.scope.getBinding(stringArrayName)
        if (!binding) return

        stringArray = {
          path: stringArrayPath!,
          references: binding.referencePaths,
          name: stringArrayName,
          length: path.node.elements.length,
        }

        // 通过引用 找到 数组乱序代码 与 解密函数代码
        binding.referencePaths.forEach((r) => {
          if (r.parentKey === 'callee') {
            const parent = r.find(p => p.isFunctionDeclaration())
            if (parent?.isFunctionDeclaration() && parent.node.id!.name !== stringArrayName) {
              // function decoder(x){
              //   return array(x)
              // }
              decoders.push(new Decoder(parent.node.id!.name, parent))
            }
          }

          if (r.parentKey === 'object') {
            const parent = r.find(p => p.isFunctionDeclaration())
            if (parent?.isFunctionDeclaration()) {
              // function decoder(x){
              //   return array[x]
              // }
              decoders.push(new Decoder(parent.node.id!.name, parent))
            }
          }

          if (r.parentKey === 'arguments') {
            const parent = r.parentPath
            const parent_expression = parent?.findParent(p => p.isExpressionStatement())
            if (parent_expression?.isExpressionStatement()) {
              // (function (h) {
              //     // ...
              // })(array)
              rotators.push(parent_expression)
              return
            }

            if (parent?.parentPath?.isVariableDeclarator()) {
              // function decoder() {
              //  var a = xxx(array)
              // }
              const funcDeclaration = parent?.parentPath.findParent(p => p.isFunctionDeclaration())
              if (funcDeclaration?.isFunctionDeclaration()) {
                decoders.push(new Decoder(funcDeclaration.node.id!.name, funcDeclaration))
              }
            }
          }
        })
      }

      path.skip()
    },
  })

  // traverse(ast, {
  //   ForStatement(path) {
  //     if (!path.node?.init && !path.node?.test && !path.node?.update) {
  //       const body = (path.parent as any).body;
  //       const index = body?.findIndex((p: any) => p == path.node);
  //       if (index >= 2) {
  //           const decodeDefine = body[index-2];
  //           const stringDefine = body[index-1];

  //           const hasDecodeDefine = decodeDefine?.declarations.length>0 && decoders.find(d => d.name == decodeDefine.declarations[0].init.name)
  //           const hasStringDefine = stringDefine?.declarations.length>0 && stringDefine.declarations[0].init.callee.name == stringArray?.name;

  //           if (hasDecodeDefine && hasStringDefine) {
  //             decodeDefine.declarations[0].remove();
  //             rotators.push(decodeDefine, stringDefine, path as any)


  //             // const start = index - 2;
  //             // const end = index;
  //             // const nodesToWrap = body.slice(start, end);
  //             // const _functionExpression = functionExpression(
  //             //   null,
  //             //   // 没有名字的匿名函数
  //             //   [],
  //             //   // 无参数
  //             //   blockStatement(nodesToWrap)
  //             //   // 原始代码的内容作为函数体
  //             // );
  //             // const iife = callExpression(
  //             //   parenthesizedExpression(_functionExpression),
  //             //   []
  //             //   // 无参数传递
  //             // );
  //             // (path.parent as any).body.splice(start,0, iife);
  //             // rotators.push(iife as any)
  //           }
  //       }
  //     }
  //   },
  // });

  // // 2. 创建闭包（IIFE）
  // traverse(ast, {
  //   Program(path) {
      
  //     if (rotators.length) {
  //       const body = path.node.body;
  //       const start = body?.findIndex((p: any) => p == rotators[0]);
  //       const end = body?.findIndex((p: any) => p == rotators[rotators.length - 1]);
  //       // 选中需要包裹闭包的节点：前两个语句
  //       const nodesToWrap = path.node.body.slice(start, end);
  //       // 创建匿名函数表达式 (function() {...})
  //       const _functionExpression = functionExpression(
  //         null, // 没有名字的匿名函数
  //         [], // 无参数
  //         blockStatement(nodesToWrap) // 原始代码的内容作为函数体
  //       );

  //       // 将函数表达式转换为立即执行的调用表达式 (function() {...})()
  //       const iife = callExpression(
  //         parenthesizedExpression(_functionExpression),
  //         [] // 无参数传递
  //       );

  //       // 替换整个 Program 的 body 为 IIFE
  //       path.node.body = [expressionStatement(iife)];
  //     }
      
  //   }
  // });


  const generateOptions = {
    compact: true,
    shouldPrintComment: () => false,
  }
  const stringArrayCode = stringArray ? generate(stringArray.path.node, generateOptions) : ''
  const rotatorCode = rotators
    .map(rotator => generate(rotator.node, generateOptions))
    .join(';\n')
  const decoderCode = decoders
    .map(decoder => generate(decoder.path.node, generateOptions))
    .join(';\n')

  let setupCode = [stringArrayCode, rotatorCode, decoderCode].join(';\n')

  setupCode  = await prettier.format(setupCode, { 
    semi: true, // 是否使用分号
    singleQuote: true, // 是否使用单引号
    tabWidth: 2, // 缩进宽度
    trailingComma: "es5", // 是否使用尾随逗号
    parser: "babel", 
  });
  
  return {
    stringArray,
    rotators,
    decoders,
    setupCode,
  }
}
