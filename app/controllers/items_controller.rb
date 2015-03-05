require_dependency 'search'

class ItemsController < ApplicationController
  respond_to :json

  def index
    search = Search.new params[:query] || ''

    limit = params[:limit] || 1000
    offset = params[:offset] || 0

    res = search.items.limit( limit ).offset( offset )

    render json: res, each_serializer: ItemSerializer, meta: { total: search.items.count }
  end

  def show
    render json: item
  end

  def add_tags
    items = nil

    Item.transaction do
      tags = Tag.find item_tag_params[:tags]
      items = Item.includes(:tags).find item_tag_params[:items]

      items.each do |item|
        tags.each do |tag|
          next if item.tags.member? tag
          item.tags.push tag
        end
      end
    end

    render json: items, each_serializer: ItemSerializer
  end

  def remove_tag
    items = nil
    Item.transaction do
      tag = Tag.find params[:tag].to_i
      items = Item.includes(:tags).find item_tag_params[:items]

      items.each do |item|
        next unless item.tags.member? tag
        item.tags.delete tag
      end
    end

    render json: items, each_serializer: ItemSerializer
  end

  private
  def item
    Item.find params[:id].to_i
  end

  def item_tag_params
    params.permit( items: [], tags: [] )
  end
end
