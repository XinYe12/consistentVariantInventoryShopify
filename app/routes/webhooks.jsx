import { authenticate, shopify } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { topic, shop, session, admin, payload } = await authenticate.webhook(
    request
  );

  if (!admin) {
    // The admin context isn't returned if the webhook fired after a shop was uninstalled.
    throw new Response();
  }

  switch (topic) {
    case "APP_UNINSTALLED":
      if (session) {
        await db.session.deleteMany({ where: { shop } });
      }
      console.log("something to Thanks Jesus");

      break;
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
    case "SHOP_REDACT":
    case "PRODUCTS_UPDATE":
      console.log("HELLO Jesus");
      const shopifyProductId = request.headers.get('x-shopify-product-id');

      //this graphql admin call is to determine whether the product is a unit/case sold product
      const metafieldsResponse = await admin.graphql(
         `#graphql
        query getVarID($input: ID!){
          product(id: $input) {
            metafields(first:10){
              edges{
                node{
                  key
                  value
                  namespace
                }
              }
            }
          }
        }`,
        {
          variables:
          {
            input: `gid://shopify/Product/${shopifyProductId}`
          }
        }
      );
      const metafieldsJson = await metafieldsResponse.json();
      let soldincase_global = false;
      let unit_percase = 0, case_inventory = 0;
      const metafields = metafieldsJson.data.product.metafields;
      if (metafields && metafields.edges){
        metafields.edges.forEach(edge =>{
            const metafield = edge.node.key;
            const value = edge.node.value;
            if (metafield=="soldincase" && value=="true"){
              soldincase_global = true;
              
            }else if(metafield=="units_percase"){
              unit_percase = edge.node.value;
              
            }else if(metafield=="caseinventnum"){
              case_inventory = edge.node.value;
              
            }
            
          }  
        );
      }else{
        console.error("soldincase not found in this product");
      }
      console.log("unit_percase: "+ unit_percase);
      console.log("metafield: " + soldincase_global);
      console.log("case_inventory: " + case_inventory);

      if (soldincase_global){
        const response  = await admin.graphql(
          `#graphql
          query getVarID($input: ID!){
            product(id: $input) {
              id
              variants(first: 2) {
                edges {
                  node {
                    id
                    title
                    inventoryQuantity
                  }
                }
              }
            }
          }`,
          {
            variables:
            {
              input: `gid://shopify/Product/${shopifyProductId}`
            }
          }
        );

        const responseJson = await response.json();
        let variantID_oneunit = "", variantID_onecase = "";
        let oneunit_invent = 0, onecase_invent = 0;//these are variables that stores the expected inventory quantity 
        let oneunit_invent_before, onecase_invent_before;
        // Accessing the variants object
        const variantsObject = responseJson.data.product.variants;
        // Checking if variantsObject is defined and has edges
        if (variantsObject && variantsObject.edges) {
          // Iterating through the edges array to get individual variant IDs
          variantsObject.edges.forEach(edge => {
            if(edge.node.title=="one unit"){
              variantID_oneunit = edge.node.id;
              oneunit_invent_before = edge.node.inventoryQuantity;
              oneunit_invent = edge.node.inventoryQuantity;
            }else if(edge.node.title=="one case"){
              variantID_onecase = edge.node.id;
              onecase_invent_before = edge.node.inventoryQuantity;
              onecase_invent = edge.node.inventoryQuantity;//onecase_invent is the metafields quantity reflecting current inventory of cases
            }
          });
        } else {
          console.error("Variants information not found in the response.");
        }
        console.log("BEFORE: oneunit invent: " + oneunit_invent  + " onecase: "+ onecase_invent+" || "+variantID_onecase+variantID_oneunit );
        const case_invent_expected = Math.floor(oneunit_invent / unit_percase); // 

        if(case_inventory == onecase_invent){
          //this means that quantity changed on "one unit", you need to update that change to case_inventory
          //NO NEED TO CHANGE oneunit
          case_inventory = case_invent_expected;
          onecase_invent = case_invent_expected;
          console.log("CHANGE ON oneunit AFTER: caseinvent_metafield: " + case_inventory + " onecase_invent: " + onecase_invent + " oneunit_inventory:  "+ oneunit_invent);

        }else{
          // if the previouse case inventory is not the same as current one, that means case inventory did change
          const caseSold = case_inventory - onecase_invent;
          oneunit_invent = oneunit_invent - (unit_percase * caseSold);
          console.log("CHANGE on onecase AFTER: oneunit_invent: " + oneunit_invent + " onecase_inventory: " + onecase_invent);
        }
        const delta_oneunit = oneunit_invent - oneunit_invent_before;
        const delta_onecase = onecase_invent - onecase_invent_before;

       const inventoryItemID_onecase = await admin.graphql(
        `#graphql
          query testing($input: ID!) {
            productVariant(id: $input) {
              id
              inventoryItem {
                id
              }
            }
          }`,
          {
            variables:{
              input: `${variantID_onecase}`
            }
          }
       );
       const inventoryItemID_oneunit = await admin.graphql(
        `#graphql
          query testing($input: ID!) {
            productVariant(id: $input) {
              id
              inventoryItem {
                id
              }
            }
          }`,
          {
            variables:{
              input: `${variantID_oneunit}`
            }
          }
       );
       const inventoryItemID_onecase_json = await inventoryItemID_onecase.json(), inventoryItemID_oneunit_json = await inventoryItemID_oneunit.json();
       const inventID_onecase = inventoryItemID_onecase_json.data.productVariant.inventoryItem.id, inventID_oneunit = inventoryItemID_oneunit_json.data.productVariant.inventoryItem.id
       console.log("inventoryitemID: " + inventoryItemID_onecase_json.data.productVariant.inventoryItem.id + inventoryItemID_oneunit_json.data.productVariant.inventoryItem.id);
       
       const finalConsistentInventory = await admin.graphql(
        `#graphql
        mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            userErrors {
              field
              message
            }
            inventoryAdjustmentGroup {
              createdAt
              reason
              referenceDocumentUri
              changes {
                name
                delta
              }
            }
          }
        }`,
          {
            variables:
            {
              input: {
                "reason": "correction",
                "name": "available",
                "changes": [
                  {
                    "delta": `${delta_onecase}`,
                    "inventoryItemId": `${inventID_onecase}`,
                    "locationId": "gid://shopify/Location/72827994361"
                  },
                  {
                    "delta": `${delta_oneunit}`,
                    "inventoryItemId": `${inventID_oneunit}`,
                    "locationId": "gid://shopify/Location/72827994361"
                  }
                ]
              }
            }
          }
       );
 
      
      }

      break;
    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response();
};
